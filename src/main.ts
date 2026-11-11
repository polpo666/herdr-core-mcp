import { AuditLog } from "./audit.js";
import { loadConfig } from "./config.js";
import { HerdrCoreClient } from "./core/client.js";
import { HerdrCoreLink } from "./core/link.js";
import { locateCoreSocket, normalizeSessionName } from "./core/socket.js";
import { startServer } from "./http/server.js";

function log(event: string, detail: Record<string, unknown>): void {
  console.log(JSON.stringify({ at: new Date().toISOString(), event, ...detail }));
}

async function main(): Promise<void> {
  const config = loadConfig();
  const session = normalizeSessionName(config.session);
  const located = locateCoreSocket(session);
  const link = new HerdrCoreLink(located, session);
  const client = new HerdrCoreClient(link);
  const audit = new AuditLog(config.auditFile);

  log("core_socket", { path: located.path, source: located.source, session });

  const running = await startServer(config, client, audit);

  process.on("beforeExit", (code) => {
    log("before_exit", {
      code,
      handles: process.getActiveResourcesInfo(),
    });
  });
  process.on("unhandledRejection", (reason) => {
    console.error(JSON.stringify({
      at: new Date().toISOString(),
      event: "unhandled_rejection",
      message: reason instanceof Error ? reason.message : String(reason),
    }));
  });

  const stop = async (signal: string) => {
    log("shutdown", { signal });
    await running.close();
    link.close();
    process.exit(0);
  };
  process.once("SIGTERM", () => void stop("SIGTERM"));
  process.once("SIGINT", () => void stop("SIGINT"));
}

main().catch((error: unknown) => {
  console.error(JSON.stringify({
    at: new Date().toISOString(),
    event: "fatal",
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
  }));
  process.exit(1);
});
