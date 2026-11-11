// Configuration comes from the environment first, then ~/.herdr-mcp/auth.json
// for the one secret this server keeps (the owner password).

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface Config {
  host: string;
  port: number;
  publicBaseUrl: URL;
  allowedHosts: string[];
  stateDir: string;
  session: string;
  ownerPassword: string;
  readOnly: boolean;
  allowedMachines: string[] | null;
  authFile: string;
  auditFile: string;
  logRequests: boolean;
}

interface AuthFile {
  ownerPassword?: string;
}

function env(name: string): string | undefined {
  const value = process.env[name];
  return value !== undefined && value.length > 0 ? value : undefined;
}

function readAuthFile(path: string): AuthFile {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as AuthFile;
  } catch {
    return {};
  }
}

function splitList(value: string | undefined): string[] | null {
  if (!value) return null;
  const items = value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  return items.length > 0 ? items : null;
}

export function loadConfig(): Config {
  const stateDir = env("HERDR_MCP_STATE_DIR") ?? join(homedir(), ".herdr-mcp");
  const authFile = join(stateDir, "auth.json");
  const auth = readAuthFile(authFile);
  const ownerPassword = env("HERDR_MCP_OWNER_PASSWORD") ?? auth.ownerPassword ?? "";
  if (ownerPassword === "") {
    throw new Error(
      `缺少 owner 口令：写入 ${authFile} 的 {"ownerPassword":"..."}（权限 0600），或设置 HERDR_MCP_OWNER_PASSWORD。`,
    );
  }

  const publicBaseUrl = new URL(env("HERDR_MCP_PUBLIC_URL") ?? "http://127.0.0.1:18790");
  const host = env("HERDR_MCP_HOST") ?? "127.0.0.1";
  const port = Number(env("HERDR_MCP_PORT") ?? "18790");
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error("HERDR_MCP_PORT 必须是 1-65535 的整数。");
  }

  const configuredHosts = splitList(env("HERDR_MCP_ALLOWED_HOSTS"));
  const defaultHosts = new Set([host, "127.0.0.1", "localhost", publicBaseUrl.hostname]);
  const allowedHosts = configuredHosts ?? [...defaultHosts];

  return {
    host,
    port,
    publicBaseUrl,
    allowedHosts,
    stateDir,
    session: env("HC_SESSION") ?? "default",
    ownerPassword,
    readOnly: env("HERDR_MCP_READ_ONLY") === "1",
    allowedMachines: splitList(env("HERDR_MCP_MACHINES")),
    authFile,
    auditFile: join(stateDir, "audit.log"),
    logRequests: env("HERDR_MCP_LOG_REQUESTS") !== "0",
  };
}
