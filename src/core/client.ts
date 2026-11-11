// Typed wrappers over the herdr-core methods this server exposes. Every method
// that mutates a terminal is marked so a timeout is reported as an unknown
// outcome rather than being retried blindly.

import { CoreRpcError, type HerdrCoreLink } from "./link.js";

export const WAIT_LIMIT_SECONDS = 40;

export interface TerminalStatus {
  state: "idle" | "working" | "done" | "blocked" | "error";
  kind?: "permission" | "question" | "auth" | string;
  progress?: number;
  app?: string;
  title?: string;
  msg?: string;
}

export interface Terminal {
  address: string;
  name: string | null;
  labels: Record<string, string>;
  argv: string[];
  cwd: string;
  state: "live" | "finished";
  pid: number | null;
  exit_code: number | null;
  signal: number | null;
  reason: string | null;
  created_ms: number;
  finished_ms: number | null;
  screen: "exact" | "inexact";
  cols: number;
  rows: number;
  status: TerminalStatus | null;
  records?: Record<string, TerminalStatus>;
  status_ms: number | null;
  turn: number;
  reported: boolean;
  title: string;
  parent: string | null;
  foreground: { pid: number; name: string; argv: string[]; cwd: string } | null;
  first_message?: { sent: boolean; started?: boolean | null; turn?: number | null; reason?: string | null } | null;
}

export interface MachineView {
  name: string;
  target?: string | null;
  state: "connecting" | "connected" | "needs_login" | "unreachable";
  host?: string | null;
  version?: string | null;
  why?: string | null;
}

export interface TerminalList {
  terminals: Terminal[];
  hidden_finished?: number;
  machines?: MachineView[];
}

export interface ReadResult {
  text: string;
  complete: boolean;
  how: "screen" | "history" | "stitched";
  why: string | null;
}

export interface SendResult {
  turn: number;
  started: boolean | null;
  status: string | null;
  wait?: WaitResult | null;
}

export interface KeysResult {
  turn: number;
  status: string | null;
}

export interface InterruptResult {
  key: string;
  outcome: string;
}

export interface WaitResult {
  terminal: string;
  ended: boolean;
  reason: string;
  turn?: number;
  status?: string | null;
  exit_code?: number | null;
  signal?: number | null;
  output?: string | null;
}

const AGENT_NAMES: Record<string, string> = {
  "claude": "claude",
  "claude-code": "claude",
  codex: "codex",
  pi: "pi",
  gemini: "gemini",
  cursor: "cursor",
  opencode: "opencode",
  copilot: "copilot",
  cline: "cline",
  devin: "devin",
  grok: "grok",
  aider: "aider",
};

const SHELLS = new Set(["zsh", "bash", "sh", "fish", "nu", "dash", "ksh", "tcsh"]);

function baseName(program: string): string {
  const parts = program.split(/[\\/]/);
  return parts[parts.length - 1] ?? program;
}

/** A short agent name for display: the status app, else the foreground program. */
export function agentName(terminal: Terminal): string {
  const app = terminal.status?.app?.toLowerCase();
  if (app) {
    for (const [needle, name] of Object.entries(AGENT_NAMES)) {
      if (app.includes(needle)) return name;
    }
    return app;
  }
  const foreground = terminal.foreground?.name ?? baseName(terminal.foreground?.argv?.[0] ?? terminal.argv?.[0] ?? "");
  const lower = foreground.toLowerCase();
  if (SHELLS.has(lower)) return "shell";
  return AGENT_NAMES[lower] ?? lower;
}

export function describeError(error: unknown): string {
  if (!(error instanceof CoreRpcError)) {
    return error instanceof Error ? error.message : String(error);
  }
  switch (error.kind) {
    case "not_found":
      return "终端不存在（可能已结束或被移除）。先用 list_terminals 确认地址。";
    case "blocked":
      return "该终端正在等待人工确认（blocked），MCP 不会代替你点同意。请在 Herdr 里处理后再试。";
    case "status_mismatch":
      return "终端当前状态与要求的 if 条件不符，这次没有发送。";
    case "finished":
      return "终端里的程序已经退出，无法再发送输入。";
    case "machine_unknown":
      return "没有这台机器的连接。先用 list_machines 查看，或在 herdr 里添加机器。";
    case "unavailable":
      return "目标 core 暂时不可用，稍后重试。";
    case "core_not_running":
      return "herdr-core 没有运行，MCP server 无法访问终端。";
    case "outcome_unknown":
      return `${error.message} 不要直接重发：先 read_terminal 看实际状态。`;
    default:
      return error.hint ? `${error.message}（${error.hint}）` : error.message;
  }
}

export class HerdrCoreClient {
  constructor(readonly link: HerdrCoreLink) {}

  async serverStatus(): Promise<unknown> {
    return this.link.call("server.status");
  }

  async listTerminals(options: { all?: boolean; labels?: Record<string, string> } = {}): Promise<TerminalList> {
    const result = (await this.link.call("terminal.list", {
      all: options.all ?? false,
      labels: options.labels ?? {},
    })) as TerminalList;
    return { terminals: result.terminals ?? [], hidden_finished: result.hidden_finished, machines: result.machines ?? [] };
  }

  async listMachines(): Promise<MachineView[]> {
    const result = (await this.link.call("machine.list")) as { machines?: MachineView[] };
    return result.machines ?? [];
  }

  async getTerminal(terminal: string): Promise<Terminal> {
    return (await this.link.call("terminal.get", { terminal })) as Terminal;
  }

  async readTerminal(terminal: string, lines: number): Promise<ReadResult> {
    return (await this.link.call("terminal.read", { terminal, lines }, { timeoutMs: 20_000 })) as ReadResult;
  }

  async waitTerminal(terminal: string, timeoutSeconds: number, output?: string): Promise<WaitResult> {
    const timeout = Math.min(Math.max(1, Math.floor(timeoutSeconds)), WAIT_LIMIT_SECONDS);
    const params: Record<string, unknown> = { terminal, timeout };
    if (output && output.length > 0) params.output = output;
    return (await this.link.call("terminal.wait", params, { timeoutMs: (timeout + 10) * 1000 })) as WaitResult;
  }

  async sendText(
    terminal: string,
    text: string,
    options: { wait?: boolean; timeoutSeconds?: number; ifStatus?: "idle" | "working" } = {},
  ): Promise<SendResult> {
    const params: Record<string, unknown> = { terminal, text, force: false };
    if (options.ifStatus) params.if = options.ifStatus;
    if (options.wait) {
      const timeout = Math.min(Math.max(1, Math.floor(options.timeoutSeconds ?? WAIT_LIMIT_SECONDS)), WAIT_LIMIT_SECONDS);
      params.wait = true;
      params.timeout = timeout;
    }
    const timeoutMs = options.wait
      ? (Math.min(Math.max(1, Math.floor(options.timeoutSeconds ?? WAIT_LIMIT_SECONDS)), WAIT_LIMIT_SECONDS) + 15) * 1000
      : 20_000;
    return (await this.link.call("terminal.send", params, { timeoutMs, mutation: true })) as SendResult;
  }

  async sendKeys(terminal: string, keys: string[]): Promise<KeysResult> {
    return (await this.link.call("terminal.keys", { terminal, keys }, { timeoutMs: 20_000, mutation: true })) as KeysResult;
  }

  async interruptTerminal(terminal: string, timeoutSeconds = 10): Promise<InterruptResult> {
    const timeout = Math.min(Math.max(1, Math.floor(timeoutSeconds)), 25);
    return (await this.link.call("terminal.interrupt", { terminal, timeout }, {
      timeoutMs: (timeout + 10) * 1000,
      mutation: true,
    })) as InterruptResult;
  }
}
