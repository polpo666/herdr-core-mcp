# herdr-core-mcp

[![CI](https://github.com/polpo666/herdr-core-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/polpo666/herdr-core-mcp/actions/workflows/ci.yml)

A remote [MCP](https://modelcontextprotocol.io) server that lets **ChatGPT web** see and talk to
[herdr-core](https://github.com/polpo666/heeler) terminals — coding agents like Claude Code, Codex
and pi, plus plain shells — across the machines your core is federated with.

herdr-core speaks line-delimited JSON-RPC 2.0 over a Unix socket. ChatGPT's custom connectors only
speak **Streamable HTTP over HTTPS with OAuth 2.1** (no API keys). This project is the bridge:

```
ChatGPT (cloud) ──HTTPS──▶ Cloudflare Tunnel / any reverse proxy
                              │ 127.0.0.1:18790
                              ▼
                        herdr-core-mcp ──unix socket JSON-RPC──▶ herdr-core
                                                                    └─ federated machines (machine/t7)
```

## Tools

| Tool | What it does | Access |
|---|---|---|
| `list_terminals` | List terminals across this core and federated machines, with filters | read-only |
| `get_terminal` | Status, turn, cwd, foreground process, labels, first-message delivery | read-only |
| `read_terminal` | Screen plus up to 200 lines of history, as plain text | read-only |
| `wait_terminal` | Wait until idle, exit, or a specific string appears (≤ 40 s per call) | read-only |
| `list_machines` | Federated machines and their connection state | read-only |
| `send_message` | Paste text and press Enter; refused while the terminal is `blocked` | write |
| `send_keys` | Press named keys (`enter`, `esc`, `ctrl+c`, …) | write |
| `interrupt_terminal` | Press the stop key and report what happened | write |

There is deliberately **no** tool to start new terminals, run arbitrary commands, kill, or remove
terminals. Every write is appended to `~/.herdr-mcp/audit.log` (mode 0600).

## Security model

- **OAuth 2.1 only.** Authorization code + PKCE S256, dynamic client registration, and a single
  owner password page. ChatGPT cannot send custom API keys, so this is the only safe way to expose
  write actions.
- **Terminal output is untrusted.** Both the server instructions and every tool description tell the
  model to treat screen contents as data, never as instructions. Read tools are still a
  prompt-injection surface: only connect an account you trust.
- **Blocked terminals are never answered for you.** `send_message` always sends `force: false`, so a
  permission dialog has to be approved in Herdr by a human.
- **Data leaves the machine.** Terminal screens are sent to OpenAI. Do not point this at terminals
  that display secrets.
- Optional hardening: `HERDR_MCP_READ_ONLY=1` registers only the five read tools;
  `HERDR_MCP_MACHINES=box-a,box-b` limits reachable machines.

## Quick start

```sh
npm install
npm test        # wire vectors, fake core, full OAuth + MCP round trip
npm run build
```

Run locally against your own core:

```sh
export HERDR_MCP_OWNER_PASSWORD=dev
export HERDR_MCP_PUBLIC_URL=http://127.0.0.1:18790
npm run dev
```

Smoke-test a running server (local or public):

```sh
SMOKE_PASSWORD=dev npm run smoke -- --base http://127.0.0.1:18790
SMOKE_PASSWORD=dev npm run smoke -- --base https://mcp.example.com --terminal t7 --send "echo hi"
```

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `HERDR_MCP_HOST` | `127.0.0.1` | Bind address; keep it on loopback and expose it through a tunnel |
| `HERDR_MCP_PORT` | `18790` | Port |
| `HERDR_MCP_PUBLIC_URL` | `http://127.0.0.1:18790` | OAuth issuer and resource base; must equal the URL clients use |
| `HERDR_MCP_STATE_DIR` | `~/.herdr-mcp` | `auth.json`, `oauth.json`, `audit.log` |
| `HERDR_MCP_OWNER_PASSWORD` | — | Overrides `ownerPassword` in `auth.json` |
| `HERDR_MCP_ALLOWED_HOSTS` | host + public URL host | Host header allowlist |
| `HERDR_MCP_READ_ONLY` | `0` | `1` registers read-only tools only |
| `HERDR_MCP_MACHINES` | all | Comma-separated machine allowlist |
| `HC_SESSION` / `HC_SOCKET` | `default` / auto | Which herdr-core session to drive |

`auth.json`:

```json
{ "ownerPassword": "…" }
```

Keep it at mode `0600`; generate with `openssl rand -base64 24`.

## Deploy

Any always-on host that runs herdr-core (or can reach its socket) and has a public HTTPS entry point
works. The included script targets macOS + launchd:

```sh
REMOTE=you@server PUBLIC_URL=https://mcp.example.com ./deploy/install.sh
```

It builds locally, syncs to `~/herdr-core-mcp`, runs `npm ci --omit=dev`, renders a launchd agent
(`com.herdr-core-mcp` by default), restarts it, and hits `/healthz`.

Then point a tunnel or reverse proxy at `127.0.0.1:18790`. With Cloudflare Tunnel:

```yaml
# ~/.cloudflared/herdr-core-mcp.yml
tunnel: <tunnel-id>
credentials-file: /home/you/.cloudflared/<tunnel-id>.json
ingress:
  - hostname: mcp.example.com
    service: http://127.0.0.1:18790
  - service: http_status:404
```

```sh
cloudflared tunnel create herdr-core-mcp
cloudflared --config ~/.cloudflared/herdr-core-mcp.yml tunnel route dns herdr-core-mcp mcp.example.com
cloudflared --config ~/.cloudflared/herdr-core-mcp.yml tunnel run
```

`tunnel route dns` reads `~/.cloudflared/config.yml` by default; pass `--config` explicitly or the
CNAME lands on the wrong tunnel. On networks where DNS is hijacked (fake-IP resolvers), cloudflared
may need `--protocol http2 --edge <real-edge-ip>:7844`.

## Connect ChatGPT

1. Settings → Apps & Connectors → Advanced → enable **Developer mode** (paid plans).
2. **Create** → MCP server URL `https://mcp.example.com/mcp`.
3. Approve the OAuth page with the owner password.
4. In a chat: `+` → More → Developer mode → enable the connector. It has to be enabled per chat.

If the plan does not allow write tools, set `HERDR_MCP_READ_ONLY=1` and restart; the connector then
advertises only the five read tools.

## How it works

- `src/core/frames.ts`, `src/core/socket.ts` — framed protocol and socket discovery, ported from
  Heeler's plugin helper (Apache-2.0). Wire vectors live in `test/fixtures/`.
- `src/core/link.ts` — one connection: `hello {generation:1, framed:true}`, then channel-0
  JSON-RPC with request correlation, per-call timeouts, mutation outcome-unknown handling, and
  reconnect detection (`core.id` change).
- `src/http/oauth.ts`, `src/http/oauth-store.ts` — single-user OAuth 2.1 provider on a 0600 JSON
  file; metadata endpoints come from the official MCP SDK.
- `src/http/server.ts` — Streamable HTTP at `/mcp`, session registry, `/healthz`.
- `src/mcp/tools.ts` — the eight tools above, with annotations, output caps and audit logging.

## Troubleshooting

- **`core_not_running`** — the core is not up, or `HC_SESSION` points at another session.
- **A new instance logs "listening" and exits immediately** — another process holds the port;
  `lsof -nP -iTCP:18790 -sTCP:LISTEN`, kill the orphan, then restart the agent.
- **401 loop in ChatGPT** — `HERDR_MCP_PUBLIC_URL` differs from the URL in the connector, or the
  password is wrong.
- **Machine not listed** — `list_machines` shows the link state; federated machines are configured
  on the core (`hc machine add`), not here.
- **Connection reset** — the core restarted; the link reconnects on the next call.

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE). The protocol layer and wire vectors are
derived from [Heeler](https://github.com/polpo666/heeler), also Apache-2.0.
