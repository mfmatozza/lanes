# Security

## Reporting a vulnerability

Report it privately through [GitHub security advisories](https://github.com/mfmatozza/lanes/security/advisories/new). Do not open a public issue. Include the version, what you did, and what happened.

## In scope

- The hook (`packages/hook`): anything that refuses or loses an edit, commits files it should not, or leaks a secret into a task title, a commit or the server.
- The server (`packages/server`): authentication, tokens, the snapshot stream, the browser app at `/app`, GitHub sign-in.
- Team context (`packages/team`): text from a teammate that reaches another person's agent as an instruction instead of quoted data, or a request that runs without approval.
- The CLI, the MCP server and the VS Code extension.

Out of scope: the coding agents themselves, and your git remote.

## Known limits

These are known and documented. Reports that make them worse are still welcome.

- **Shared team token.** Without personal tokens, everyone on a team shares one token, so a teammate can act as someone else. Personal tokens (`lanes invite`, `lanes join`, `lanes login`) stop that: the server sets the caller's name from the token.
- **Chat and requests are not end-to-end encrypted yet.** The server reads them. End-to-end encryption is planned, not built.
- **Plain text on the server machine.** The server holds team state (task titles, chat, requests) in plain text in memory, and its own token in a plain file under `~/.lanes`. The member file keeps only SHA-256 hashes of personal tokens. Anyone with access to the server machine can read the rest.
- **No TLS in the server.** It speaks plain HTTP. Off a trusted network, put it behind a TLS proxy or a VPN.
- **Free text cannot be redacted reliably.** Task titles come from the first line of a prompt with known secret forms removed. `LANES_NO_PROMPT_TEXT=1` keeps prompt text out entirely.

The full threat model: [docs/architecture/security.md](docs/architecture/security.md).
