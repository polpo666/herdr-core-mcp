import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { startFakeCore } from "./fake-core.js";
import { CoreRpcError, HerdrCoreLink } from "../src/core/link.js";

test("a link handshakes, calls, and maps error kinds", async () => {
  const core = await startFakeCore({
    "server.status": () => ({ result: { version: "0.1.20" } }),
    "terminal.read": () => ({
      error: { code: -32000, message: "blocked", data: { kind: "blocked", hint: "waiting for approval" } },
    }),
    slow: () => ({ silent: true }),
  });
  const link = new HerdrCoreLink({ path: core.path, source: "env" }, "default");
  try {
    const hello = await link.connect();
    assert.equal(hello.core.id, "fake-core");
    assert.equal(hello.generation, 1);

    assert.deepEqual(await link.call("server.status"), { version: "0.1.20" });

    await assert.rejects(
      () => link.call("no.such.method"),
      (error: unknown) => error instanceof CoreRpcError && error.kind === "unknown_method",
    );
    await assert.rejects(
      () => link.call("terminal.read", { terminal: "t1" }),
      (error: unknown) => error instanceof CoreRpcError && error.kind === "blocked" && /waiting for approval/.test(error.message),
    );
    await assert.rejects(
      () => link.call("slow", {}, { timeoutMs: 150 }),
      (error: unknown) => error instanceof CoreRpcError && error.kind === "timeout",
    );
    await assert.rejects(
      () => link.call("slow", {}, { timeoutMs: 150, mutation: true }),
      (error: unknown) => error instanceof CoreRpcError && error.kind === "outcome_unknown",
    );
  } finally {
    link.close();
    await core.close();
  }
});

test("a link reports a missing socket as core_not_running", async () => {
  const link = new HerdrCoreLink({ path: "/tmp/herdr-mcp-does-not-exist.sock", source: "env" }, "default");
  await assert.rejects(
    () => link.call("server.status"),
    (error: unknown) => error instanceof CoreRpcError && error.kind === "core_not_running",
  );
  link.close();
});

test("a link reconnects and notices a different core", async () => {
  const directory = mkdtempSync(join(tmpdir(), "herdr-mcp-reconnect-"));
  const first = await startFakeCore({ "server.status": () => ({ result: { pid: 1 } }) }, { directory, coreId: "core-one" });
  const link = new HerdrCoreLink({ path: first.path, source: "env" }, "default");
  try {
    await link.connect();
    assert.equal(link.consumeCoreChanged(), false);
    await first.close();

    const second = await startFakeCore({ "server.status": () => ({ result: { pid: 2 } }) }, { directory, coreId: "core-two" });
    try {
      assert.deepEqual(await link.call("server.status"), { pid: 2 });
      assert.equal(link.consumeCoreChanged(), true);
    } finally {
      await second.close();
      rmSync(directory, { recursive: true, force: true });
    }
  } finally {
    link.close();
  }
});
