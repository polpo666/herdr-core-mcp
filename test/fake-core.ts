// A minimal herdr-core stand-in: a unix socket that answers the hello line and
// then framed JSON-RPC requests from a handler table.

import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { encodeFrame } from "../src/core/frames.js";

export type HandlerResult =
  | { result: unknown }
  | { error: { code: number; message: string; data?: { kind?: string; hint?: string } } }
  | { silent: true };

export type Handler = (params: unknown) => HandlerResult | Promise<HandlerResult>;

export interface FakeCore {
  path: string;
  coreId: string;
  close: () => Promise<void>;
}

export async function startFakeCore(
  handlers: Record<string, Handler>,
  options: { coreId?: string; directory?: string } = {},
): Promise<FakeCore> {
  const directory = options.directory ?? mkdtempSync(join(tmpdir(), "herdr-mcp-test-"));
  const path = join(directory, "core.sock");
  const coreId = options.coreId ?? "fake-core";
  const sockets = new Set<Socket>();

  const server: Server = createServer((socket) => {
    sockets.add(socket);
    let buffer = Buffer.alloc(0);
    let framed = false;
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => sockets.delete(socket));
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!framed) {
        const newline = buffer.indexOf(0x0a);
        if (newline === -1) return;
        JSON.parse(buffer.subarray(0, newline).toString("utf8"));
        buffer = buffer.subarray(newline + 1);
        framed = true;
        socket.write(`${JSON.stringify({
          jsonrpc: "2.0",
          id: "hello",
          result: {
            core: { id: coreId, name: "fake-core" },
            version: "0.1.20",
            generation: 1,
            framed: true,
            features: ["framed", "events", "status", "attach", "shell"],
            methods: Object.keys(handlers),
          },
        })}\n`);
      }

      while (buffer.length >= 9) {
        const length = buffer.readUInt32LE(5);
        if (buffer.length < 9 + length) break;
        const payload = buffer.subarray(9, 9 + length);
        buffer = buffer.subarray(9 + length);
        const request = JSON.parse(payload.toString("utf8")) as { id: string; method: string; params: unknown };
        const handler = handlers[request.method];
        const outcome: HandlerResult | Promise<HandlerResult> = handler
          ? handler(request.params)
          : { error: { code: -32601, message: "unknown method", data: { kind: "unknown_method" } } };
        void Promise.resolve(outcome)
          .then((value) => {
            if ("silent" in value) return;
            const body = "error" in value
              ? { jsonrpc: "2.0", id: request.id, error: value.error }
              : { jsonrpc: "2.0", id: request.id, result: value.result };
            socket.write(encodeFrame({ channel: 0, kind: 0, payload: Buffer.from(JSON.stringify(body), "utf8") }));
          })
          .catch(() => {
            socket.write(encodeFrame({
              channel: 0,
              kind: 0,
              payload: Buffer.from(JSON.stringify({
                jsonrpc: "2.0",
                id: request.id,
                error: { code: -32000, message: "handler failed", data: { kind: "handler_failed" } },
              }), "utf8"),
            }));
          });
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(path, resolve));

  return {
    path,
    coreId,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (options.directory === undefined) rmSync(directory, { recursive: true, force: true });
    },
  };
}
