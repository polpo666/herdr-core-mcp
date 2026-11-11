// One framed JSON-RPC connection to a herdr-core socket. The link opens
// nothing by itself: a core that is not running stays stopped, and the first
// call reports `core_not_running`.

import { createConnection, type Socket } from "node:net";

import { FrameDecoder, FRAME_KIND, helloLine, requestFrame, type Frame } from "./frames.js";
import type { LocatedSocket } from "./socket.js";

const HANDSHAKE_TIMEOUT_MS = 10_000;
const MAXIMUM_HELLO_LINE = 1024 * 1024;
const REQUIRED_FEATURES = ["framed", "status"];

export class CoreRpcError extends Error {
  constructor(
    readonly kind: string,
    message: string,
    readonly hint?: string,
    readonly rpcCode?: number,
  ) {
    super(message);
    this.name = "CoreRpcError";
  }
}

export interface CoreHello {
  core: { id: string; name: string };
  version: string;
  generation: number;
  features: string[];
  methods: string[];
  framed: boolean;
}

interface PendingCall {
  method: string;
  mutation: boolean;
  timer: NodeJS.Timeout;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

export interface CallOptions {
  timeoutMs?: number;
  /** A call that changes terminals: a timeout means the outcome is unknown. */
  mutation?: boolean;
}

function wrapTransportError(error: NodeJS.ErrnoException): Error {
  if (error.code === "ENOENT") {
    return new CoreRpcError("core_not_running", "找不到 herdr-core 的 socket。", "确认 herdr-core 正在运行，或检查 HC_SESSION / HC_SOCKET。");
  }
  if (error.code === "ECONNREFUSED") {
    return new CoreRpcError("core_not_running", "herdr-core 没有在 socket 上监听。", "启动 herdr-core（或 hc server start）后重试。");
  }
  if (error.code === "EACCES") {
    return new CoreRpcError("socket_denied", "没有权限访问 herdr-core 的 socket。", "MCP server 必须用启动 core 的同一用户运行。");
  }
  if (error.code === "EPIPE" || error.code === "ECONNRESET" || error.code === "ERR_STREAM_DESTROYED") {
    return new CoreRpcError("core_disconnected", "与 herdr-core 的连接已断开。", "稍后重试；下一次调用会自动重连。");
  }
  return error;
}

function parseError(payload: Buffer): CoreRpcError {
  let body: unknown;
  try {
    body = JSON.parse(payload.toString("utf8"));
  } catch {
    return new CoreRpcError("invalid_response", "herdr-core 返回了无法解析的消息。");
  }
  const error = (body as { error?: { code?: number; message?: string; data?: { kind?: string; hint?: string } } }).error;
  if (!error) return new CoreRpcError("invalid_response", "herdr-core 返回了错误格式的响应。");
  const kind = error.data?.kind ?? "core_error";
  const hint = error.data?.hint;
  const message = hint ? `${error.message ?? kind}（${hint}）` : (error.message ?? kind);
  return new CoreRpcError(kind, message, hint, error.code);
}

export class HerdrCoreLink {
  #socket: Socket | null = null;
  #decoder = new FrameDecoder();
  #helloChunks: Buffer[] = [];
  #helloBytes = 0;
  #hello: CoreHello | null = null;
  #pending = new Map<string, PendingCall>();
  #nextId = 0;
  #connecting: Promise<CoreHello> | null = null;
  #writeChain: Promise<void> = Promise.resolve();
  #previousCoreId: string | null = null;
  #coreChanged = false;

  constructor(
    readonly located: LocatedSocket,
    readonly session: string,
  ) {}

  get hello(): CoreHello | null {
    return this.#hello;
  }

  get connected(): boolean {
    return this.#socket !== null && this.#socket.writable && !this.#socket.destroyed && this.#hello !== null;
  }

  /** True once after a reconnect reached a different core process. */
  consumeCoreChanged(): boolean {
    const changed = this.#coreChanged;
    this.#coreChanged = false;
    return changed;
  }

  async connect(): Promise<CoreHello> {
    if (this.connected) return this.#hello!;
    if (this.#connecting) return this.#connecting;
    this.#connecting = this.#open().finally(() => {
      this.#connecting = null;
    });
    return this.#connecting;
  }

  async call(method: string, params: unknown = {}, options: CallOptions = {}): Promise<unknown> {
    try {
      return await this.#callOnce(method, params, options);
    } catch (error) {
      // A read may safely retry once on a connection that died mid-flight; a
      // mutation may not, because its outcome is unknown.
      const retryable = !options.mutation && error instanceof CoreRpcError && error.kind === "core_disconnected";
      if (!retryable) throw error;
      return this.#callOnce(method, params, options);
    }
  }

  async #callOnce(method: string, params: unknown, options: CallOptions): Promise<unknown> {
    await this.connect();
    const id = String(++this.#nextId);
    const timeoutMs = options.timeoutMs ?? 10_000;
    const mutation = options.mutation === true;

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        if (mutation) {
          reject(
            new CoreRpcError(
              "outcome_unknown",
              `${method} 在 ${Math.round(timeoutMs / 1000)} 秒内没有返回，结果未知。`,
              "不要直接重发；先读终端确认实际状态。",
            ),
          );
        } else {
          reject(new CoreRpcError("timeout", `${method} 在 ${Math.round(timeoutMs / 1000)} 秒内没有返回。`, "稍后重试。"));
        }
      }, timeoutMs);

      this.#pending.set(id, { method, mutation, timer, resolve, reject });
      this.#enqueueWrite(requestFrame(id, method, params), method);
    });
  }

  close(): void {
    this.#socket?.destroy();
    this.#socket = null;
  }

  #open(): Promise<CoreHello> {
    return new Promise<CoreHello>((resolve, reject) => {
      const socket = createConnection({ path: this.located.path });
      let settled = false;

      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        reject(error);
      };

      const timer = setTimeout(() => {
        fail(new CoreRpcError("handshake_timeout", "herdr-core 没有在 10 秒内完成握手。", "检查 core.log，或稍后重试。"));
      }, HANDSHAKE_TIMEOUT_MS);
      timer.unref?.();

      socket.on("error", (error) => {
        if (!settled) fail(wrapTransportError(error as NodeJS.ErrnoException));
      });
      socket.once("connect", () => {
        this.#socket = socket;
        this.#decoder = new FrameDecoder();
        this.#helloChunks = [];
        this.#helloBytes = 0;
        socket.write(helloLine());
      });
      socket.on("data", (chunk: Buffer) => {
        if (this.#socket !== socket) return;
        if (!settled) {
          this.#receiveHello(chunk, (hello) => {
            settled = true;
            clearTimeout(timer);
            resolve(hello);
          }, fail);
          return;
        }
        this.#receiveFrames(chunk);
      });
      socket.on("close", () => {
        if (this.#socket !== socket) return;
        if (!settled) {
          fail(new CoreRpcError("core_disconnected", "herdr-core 在握手完成前关闭了连接。", "检查 core 是否正在重启。"));
          return;
        }
        this.#socket = null;
        this.#hello = null;
        this.#failPending(new CoreRpcError("core_disconnected", "与 herdr-core 的连接已断开。", "稍后重试；下一次调用会自动重连。"));
      });
    });
  }

  #receiveHello(chunk: Buffer, resolve: (hello: CoreHello) => void, fail: (error: Error) => void): void {
    this.#helloChunks.push(chunk);
    this.#helloBytes += chunk.length;
    if (this.#helloBytes > MAXIMUM_HELLO_LINE) {
      fail(new CoreRpcError("handshake_failed", "herdr-core 的 hello 响应过大。"));
      return;
    }
    const buffered = Buffer.concat(this.#helloChunks);
    const newline = buffered.indexOf(0x0a);
    if (newline === -1) return;

    const line = buffered.subarray(0, newline).toString("utf8");
    const rest = buffered.subarray(newline + 1);

    let body: {
      result?: CoreHello;
      error?: { code?: number; message?: string; data?: { kind?: string; hint?: string } };
    };
    try {
      body = JSON.parse(line);
    } catch {
      fail(new CoreRpcError("handshake_failed", "herdr-core 的 hello 响应不是 JSON。"));
      return;
    }
    if (body.error) {
      fail(parseError(Buffer.from(line)));
      return;
    }
    const hello = body.result;
    if (!hello || hello.generation !== 1) {
      fail(new CoreRpcError("unsupported_generation", "herdr-core 使用了不支持的协议版本。", "升级 hc / herdr-core，或升级本 MCP server。"));
      return;
    }
    if (hello.framed !== true) {
      fail(new CoreRpcError("handshake_failed", "herdr-core 没有切换到 framed 模式。"));
      return;
    }
    const features = Array.isArray(hello.features) ? hello.features : [];
    for (const feature of REQUIRED_FEATURES) {
      if (!features.includes(feature)) {
        fail(new CoreRpcError("unsupported_core", `herdr-core 缺少 ${feature} 能力。`, "升级 herdr-core。"));
        return;
      }
    }

    if (this.#previousCoreId !== null && this.#previousCoreId !== hello.core.id) {
      this.#coreChanged = true;
    }
    this.#previousCoreId = hello.core.id;
    this.#hello = hello;
    this.#helloChunks = [];
    this.#helloBytes = 0;
    resolve(hello);
    if (rest.length > 0) this.#receiveFrames(rest);
  }

  #receiveFrames(chunk: Buffer): void {
    this.#decoder.append(chunk);
    try {
      for (let frame = this.#decoder.next(); frame !== null; frame = this.#decoder.next()) {
        this.#handleFrame(frame);
      }
    } catch (error) {
      this.#socket?.destroy();
      this.#failPending(error instanceof Error ? error : new Error(String(error)));
    }
  }

  #handleFrame(frame: Frame): void {
    if (frame.kind !== FRAME_KIND.data || frame.channel !== 0) return;
    let body: { id?: string; result?: unknown; error?: unknown };
    try {
      body = JSON.parse(frame.payload.toString("utf8"));
    } catch {
      return;
    }
    if (typeof body.id !== "string") return;
    const pending = this.#pending.get(body.id);
    if (!pending) return;
    this.#pending.delete(body.id);
    clearTimeout(pending.timer);
    if (body.error) {
      pending.reject(parseError(frame.payload));
      return;
    }
    pending.resolve(body.result);
  }

  #enqueueWrite(buffer: Buffer, method: string): void {
    this.#writeChain = this.#writeChain
      .then(
        () =>
          new Promise<void>((resolve, reject) => {
            const socket = this.#socket;
            if (!socket || socket.destroyed) {
              reject(new CoreRpcError("core_disconnected", `连接已断开，无法发送 ${method}。`));
              return;
            }
            socket.write(buffer, (error) => (error ? reject(error) : resolve()));
          }),
      )
      .catch((error: Error) => {
        const mapped = error instanceof CoreRpcError ? error : wrapTransportError(error as NodeJS.ErrnoException);
        if (mapped instanceof CoreRpcError && mapped.kind === "core_disconnected") {
          this.#socket?.destroy();
          this.#socket = null;
          this.#hello = null;
        }
        this.#failPending(mapped);
      });
  }

  #failPending(error: Error): void {
    for (const [, pending] of this.#pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
  }
}
