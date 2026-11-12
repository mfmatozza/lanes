# Documentation

| Read | For |
|---|---|
| [CLI reference](cli.md) | Every `lanes` command, its options and environment variables |
| [MCP reference](mcp.md) | Adding `lanes mcp` to Claude Code, Codex, Cursor, Gemini CLI and 15 more; every tool and what it returns |
| [Architecture overview](architecture/overview.md) | The hook, the server, the extension, the app, and how an edit flows through them |
| [Coordination model](architecture/coordination-model.md) | Leases, the queue, sync on handoff and publishing to `lanes/main` |
| [Protocol](architecture/protocol.md) | The server's HTTP and WebSocket API |
| [Agent integration](architecture/agent-integration.md) | How each coding agent is hooked in |
| [VS Code extension](architecture/vscode-extension.md) | How the extension is built |
| [Security](architecture/security.md) | Threat model, tokens, what the server can see |
| [Design decisions](design.md) | Why it works this way, one paragraph per decision |
| [Benchmark](benchmark/method.md) | The method, written before the runs, and every result: [hook latency](benchmark/hook-latency.md), [scale test](benchmark/scale-2026-11-02.md), [intent conflicts round 1](benchmark/intent-2026-11-03.md) and [round 2](benchmark/intent-2026-11-09.md) |
