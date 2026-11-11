// Ported from Heeler's herdr-plugin helper (Apache-2.0, socket.js). Finds a
// session's socket the way the app's locator does (ADR 0031): `HC_SOCKET` when
// set, else the session's core.lock, else the session's default socket path.

import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const INVALID_SESSION_CHARACTERS = /[\/\\:*?"<>|\u0000-\u001f]/;

export interface LocatedSocket {
  path: string;
  source: "env" | "lock" | "default";
}

export function normalizeSessionName(raw: string | undefined): string {
  const session = (raw ?? "").trim();
  if (session === "" || session === "." || session === ".." || INVALID_SESSION_CHARACTERS.test(session)) {
    return "default";
  }
  return session;
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function readLock(stateFolder: string): string {
  try {
    return readFileSync(join(stateFolder, "core.lock"), "utf8").replace(/\n+$/, "");
  } catch {
    return "";
  }
}

export function locateCoreSocket(
  session: string,
  {
    env = process.env,
    runUserDirectory = `/run/user/${process.getuid?.() ?? 0}`,
  }: { env?: NodeJS.ProcessEnv; runUserDirectory?: string } = {},
): LocatedSocket {
  if (env.HC_SOCKET && env.HC_SOCKET.length > 0) {
    return { path: env.HC_SOCKET, source: "env" };
  }

  const stateHome = env.XDG_STATE_HOME || join(env.HOME ?? "/", ".local/state");
  const stateFolder = join(stateHome, "herdr-core", session);
  const lock = readLock(stateFolder);
  if (lock !== "") return { path: lock, source: "lock" };

  const socketFolder = env.XDG_RUNTIME_DIR
    ? join(env.XDG_RUNTIME_DIR, "herdr-core")
    : isDirectory(runUserDirectory)
      ? join(runUserDirectory, "herdr-core")
      : stateFolder;
  return { path: join(socketFolder, `${session}.sock`), source: "default" };
}
