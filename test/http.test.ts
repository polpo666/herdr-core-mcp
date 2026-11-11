import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { AuditLog } from "../src/audit.js";
import type { Config } from "../src/config.js";
import { HerdrCoreClient } from "../src/core/client.js";
import { HerdrCoreLink } from "../src/core/link.js";
import { startServer } from "../src/http/server.js";
import { startFakeCore } from "./fake-core.js";

const REDIRECT = "https://chatgpt.com/connector_platform_oauth_redirect";
const PASSWORD = "test-password";

function terminalFixture() {
  return {
    address: "t7",
    name: null,
    labels: { where: "demo / 1" },
    argv: ["zsh"],
    cwd: "/tmp/demo",
    state: "live",
    pid: 100,
    exit_code: null,
    signal: null,
    reason: null,
    created_ms: 1,
    finished_ms: null,
    screen: "exact",
    cols: 80,
    rows: 24,
    status: { state: "done", app: "claude-code" },
    status_ms: 2,
    turn: 3,
    reported: true,
    title: "demo",
    parent: null,
    foreground: { pid: 101, name: "node", argv: ["node", "claude"], cwd: "/tmp/demo" },
    first_message: null,
  };
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

test("OAuth 2.1 + Streamable HTTP serves tools end to end", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "herdr-mcp-http-"));
  const core = await startFakeCore({
    "terminal.list": () => ({ result: { terminals: [terminalFixture()], hidden_finished: 0, machines: [{ name: "build-box", state: "connected" }] } }),
    "terminal.get": () => ({ result: terminalFixture() }),
    "terminal.read": () => ({ result: { text: "$ claude\nAll tests pass\n", complete: true, how: "screen", why: null } }),
    "terminal.send": () => ({ result: { turn: 4, started: true, status: "done", wait: null } }),
    "machine.list": () => ({ result: { machines: [{ name: "build-box", state: "connected" }] } }),
  });

  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const config: Config = {
    host: "127.0.0.1",
    port,
    publicBaseUrl: new URL(base),
    allowedHosts: ["127.0.0.1", "localhost"],
    stateDir,
    session: "default",
    ownerPassword: PASSWORD,
    readOnly: false,
    allowedMachines: null,
    authFile: join(stateDir, "auth.json"),
    auditFile: join(stateDir, "audit.log"),
    logRequests: false,
  };
  const link = new HerdrCoreLink({ path: core.path, source: "env" }, "default");
  const client = new HerdrCoreClient(link);
  const audit = new AuditLog(config.auditFile);
  const running = await startServer(config, client, audit);

  try {
    const health = await fetch(`${base}/healthz`);
    assert.equal(health.status, 200);

    const unauthenticated = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    assert.equal(unauthenticated.status, 401);
    assert.match(unauthenticated.headers.get("www-authenticate") ?? "", /resource_metadata=/);

    const registration = await fetch(`${base}/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "ChatGPT",
        redirect_uris: [REDIRECT],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      }),
    });
    assert.equal(registration.status, 201);
    const clientInfo = (await registration.json()) as { client_id: string };

    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const authorizeQuery = new URLSearchParams({
      response_type: "code",
      client_id: clientInfo.client_id,
      redirect_uri: REDIRECT,
      code_challenge: challenge,
      code_challenge_method: "S256",
      scope: "mcp",
      resource: `${base}/mcp`,
      state: "state-1",
    });

    const page = await fetch(`${base}/authorize?${authorizeQuery}`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Owner 口令/);

    const wrong = await fetch(`${base}/authorize?${authorizeQuery}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ ...Object.fromEntries(authorizeQuery), owner_password: "wrong" }),
      redirect: "manual",
    });
    assert.equal(wrong.status, 401);

    const approved = await fetch(`${base}/authorize?${authorizeQuery}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ ...Object.fromEntries(authorizeQuery), owner_password: PASSWORD }),
      redirect: "manual",
    });
    assert.equal(approved.status, 302);
    const location = new URL(approved.headers.get("location") ?? "");
    assert.equal(location.origin + location.pathname, REDIRECT);
    assert.equal(location.searchParams.get("state"), "state-1");
    const code = location.searchParams.get("code");
    assert.ok(code);

    const tokenResponse = await fetch(`${base}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: code!,
        redirect_uri: REDIRECT,
        client_id: clientInfo.client_id,
        code_verifier: verifier,
        resource: `${base}/mcp`,
      }),
    });
    assert.equal(tokenResponse.status, 200);
    const tokens = (await tokenResponse.json()) as { access_token: string; refresh_token: string };
    assert.ok(tokens.access_token.startsWith(""));

    const authHeaders = {
      authorization: `Bearer ${tokens.access_token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-06-18",
    };

    const initialize = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke", version: "0" } },
      }),
    });
    assert.equal(initialize.status, 200);
    const sessionId = initialize.headers.get("mcp-session-id");
    assert.ok(sessionId);
    const initializeBody = (await initialize.json()) as { result: { serverInfo: { name: string }; instructions?: string } };
    assert.equal(initializeBody.result.serverInfo.name, "herdr-core");
    assert.match(initializeBody.result.instructions ?? "", /untrusted/);

    const sessionHeaders = { ...authHeaders, "mcp-session-id": sessionId! };

    const initialized = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: sessionHeaders,
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    });
    assert.equal(initialized.status, 202);

    const list = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: sessionHeaders,
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
    });
    assert.equal(list.status, 200);
    const listBody = (await list.json()) as { result: { tools: { name: string; annotations?: { readOnlyHint?: boolean } }[] } };
    const names = listBody.result.tools.map((tool) => tool.name).sort();
    assert.deepEqual(names, [
      "get_terminal",
      "interrupt_terminal",
      "list_machines",
      "list_terminals",
      "read_terminal",
      "send_keys",
      "send_message",
      "wait_terminal",
    ]);
    for (const tool of listBody.result.tools) {
      const isWrite = ["send_message", "send_keys", "interrupt_terminal"].includes(tool.name);
      assert.equal(tool.annotations?.readOnlyHint, !isWrite, `${tool.name} readOnlyHint`);
    }

    const call = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: sessionHeaders,
      body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "list_terminals", arguments: {} } }),
    });
    assert.equal(call.status, 200);
    const callBody = (await call.json()) as { result: { content: { text: string }[] } };
    assert.match(callBody.result.content[0]!.text, /t7/);
    assert.match(callBody.result.content[0]!.text, /build-box \(connected\)/);

    const read = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: sessionHeaders,
      body: JSON.stringify({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "read_terminal", arguments: { terminal: "t7", lines: 10 } } }),
    });
    const readBody = (await read.json()) as { result: { content: { text: string }[] } };
    assert.match(readBody.result.content[0]!.text, /All tests pass/);

    const send = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: sessionHeaders,
      body: JSON.stringify({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "send_message", arguments: { terminal: "t7", message: "please continue" } } }),
    });
    const sendBody = (await send.json()) as { result: { content: { text: string }[] } };
    assert.match(sendBody.result.content[0]!.text, /turn=4/);

    const auditText = readFileSync(config.auditFile, "utf8");
    assert.match(auditText, /send_message/);
    assert.match(auditText, /please continue/);
  } finally {
    await running.close();
    link.close();
    await core.close();
    rmSync(stateDir, { recursive: true, force: true });
  }
});
