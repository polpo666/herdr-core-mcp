# Security

This server gives a cloud model read access to terminal screens and permission to type into them.
Treat any deployment as a remote shell for the account that runs it.

## Reporting

Open a private security advisory on GitHub, or email the maintainer listed in `package.json`. Please
do not file a public issue for a vulnerability.

## Design notes

- Authentication is OAuth 2.1 (authorization code + PKCE S256, dynamic client registration, single
  owner password). There is no unauthenticated mode and no API-key mode.
- The server binds to loopback; a tunnel or reverse proxy provides TLS. `HERDR_MCP_PUBLIC_URL` must
  match the public URL, because OAuth resource and issuer checks depend on it.
- Access tokens are stored hashed in `~/.herdr-mcp/oauth.json` (0600); the owner password is read
  from `auth.json` (0600) or `HERDR_MCP_OWNER_PASSWORD`.
- There is no tool to create terminals, run arbitrary commands, kill, or remove terminals. The write
  surface is: send text, send named keys, interrupt the current turn.
- Blocked terminals (waiting for a human decision) refuse `send_message`; the server never sets
  `force: true`.
- Reads are a prompt-injection surface by design. Tool descriptions mark terminal output as data,
  but a model can still be misled by it.
- Set `HERDR_MCP_READ_ONLY=1` to expose read-only tools only.
