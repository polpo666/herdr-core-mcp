# Contributing

- `npm install`
- `npm run typecheck && npm test`
- Keep the protocol layer (`src/core/link.ts`) free of MCP concepts, and the tools
  (`src/mcp/tools.ts`) free of socket details.
- New tools need: a description that mentions untrusted terminal output, safety annotations, output
  caps, and an audit entry if they mutate anything.
- Tests should not touch a real herdr-core: use `test/fake-core.ts`, or the captured wire vectors in
  `test/fixtures/`.
- Run `npm run build` before opening a pull request; CI runs typecheck, tests and build on Node 22
  and 24.
