// End-to-end smoke: OAuth (DCR → password page → PKCE token) → initialize →
// tools/list → list_terminals → read_terminal. Works against a local server or
// the public HTTPS endpoint.
//
//   SMOKE_BASE_URL=https://mcp.example.com SMOKE_PASSWORD=... npm run smoke
//   npm run smoke -- --base http://127.0.0.1:18790 --terminal build-box/t18

import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const REDIRECT = "https://chatgpt.com/connector_platform_oauth_redirect";

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

function password(): string {
  const fromEnv = process.env.SMOKE_PASSWORD;
  if (fromEnv) return fromEnv;
  const file = join(homedir(), ".herdr-mcp", "auth.json");
  const parsed = JSON.parse(readFileSync(file, "utf8")) as { ownerPassword?: string };
  if (!parsed.ownerPassword) throw new Error(`${file} 里没有 ownerPassword`);
  return parsed.ownerPassword;
}

async function main(): Promise<void> {
  const base = argument("base") ?? process.env.SMOKE_BASE_URL ?? "http://127.0.0.1:18790";
  const target = argument("terminal") ?? process.env.SMOKE_TERMINAL;
  const mcpUrl = new URL("/mcp", base);

  const registration = await fetch(new URL("/register", base), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "herdr-mcp smoke",
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    }),
  });
  if (registration.status !== 201) throw new Error(`register failed: ${registration.status} ${await registration.text()}`);
  const { client_id } = (await registration.json()) as { client_id: string };

  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const query = new URLSearchParams({
    response_type: "code",
    client_id,
    redirect_uri: REDIRECT,
    code_challenge: challenge,
    code_challenge_method: "S256",
    scope: "mcp",
    resource: mcpUrl.href,
    state: "smoke",
  });

  const authorize = await fetch(new URL(`/authorize?${query}`, base), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ ...Object.fromEntries(query), owner_password: password() }),
    redirect: "manual",
  });
  if (authorize.status !== 302) throw new Error(`authorize failed: ${authorize.status} ${await authorize.text()}`);
  const code = new URL(authorize.headers.get("location") ?? "").searchParams.get("code");
  if (!code) throw new Error("authorize returned no code");

  const tokenResponse = await fetch(new URL("/token", base), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT,
      client_id,
      code_verifier: verifier,
      resource: mcpUrl.href,
    }),
  });
  if (tokenResponse.status !== 200) throw new Error(`token failed: ${tokenResponse.status} ${await tokenResponse.text()}`);
  const tokens = (await tokenResponse.json()) as { access_token: string };

  const transport = new StreamableHTTPClientTransport(mcpUrl, {
    requestInit: { headers: { authorization: `Bearer ${tokens.access_token}` } },
  });
  const client = new Client({ name: "herdr-mcp-smoke", version: "0.1.0" });
  await client.connect(transport);
  console.log(`connected to ${mcpUrl.href}`);

  const tools = await client.listTools();
  console.log(`tools: ${tools.tools.map((tool) => tool.name).join(", ")}`);

  const list = await client.callTool({ name: "list_terminals", arguments: {} });
  const listText = textOf(list);
  console.log("--- list_terminals ---");
  console.log(listText.split("\n").slice(0, 15).join("\n"));

  const address = target ?? firstAddress(listText);
  if (!address) throw new Error("没有可读的终端；用 --terminal 指定一个");
  const read = await client.callTool({ name: "read_terminal", arguments: { terminal: address, lines: 5 } });
  console.log(`--- read_terminal ${address} ---`);
  console.log(textOf(read).split("\n").slice(0, 40).join("\n"));

  const message = argument("send");
  if (message) {
    const sent = await client.callTool({ name: "send_message", arguments: { terminal: address, message } });
    console.log(`--- send_message ${address} ---`);
    console.log(textOf(sent));
    await new Promise((resolve) => setTimeout(resolve, 1200));
    const after = await client.callTool({ name: "read_terminal", arguments: { terminal: address, lines: 20 } });
    console.log(`--- read_terminal after send ---`);
    console.log(textOf(after).split("\n").slice(-20).join("\n"));
  }

  await client.close();
}

function textOf(result: unknown): string {
  const content = (result as { content?: { type: string; text?: string }[] }).content ?? [];
  return content.map((item) => item.text ?? "").filter((item) => item.length > 0).join("\n");
}

function firstAddress(listText: string): string | null {
  for (const line of listText.split("\n")) {
    const match = /^- (\S+)\s+/.exec(line);
    const address = match?.[1];
    if (address) return address;
  }
  return null;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
