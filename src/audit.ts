// One JSON line per write action, so a human can see what ChatGPT did to their
// terminals without reading the server's stdout history.

import { appendFileSync, chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface AuditEntry {
  tool: string;
  terminal: string;
  summary: string;
  outcome: "ok" | "error";
  detail?: string;
  clientId?: string;
}

export class AuditLog {
  constructor(private readonly path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    chmodSync(dirname(path), 0o700);
  }

  write(entry: AuditEntry): void {
    const line = JSON.stringify({ at: new Date().toISOString(), ...entry });
    try {
      appendFileSync(this.path, `${line}\n`, { mode: 0o600 });
    } catch {
      // Auditing must never fail the action it records.
    }
  }
}

/** Shortens terminal text for the log: enough to recognize, not enough to leak a whole screen. */
export function summarize(text: string, limit = 160): string {
  const singleLine = text.replace(/\s+/g, " ").trim();
  return singleLine.length <= limit ? singleLine : `${singleLine.slice(0, limit)}…`;
}
