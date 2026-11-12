# Hook latency

Every edit an agent makes first goes through the Lanes hook, which asks the server for a lease. If that check is slow, every agent on the team is slower. The target is **p95 under 100 ms** for an edit of a free file, process start included.

## Result

The bundled hook (`dist/hook.cjs`), one allowed edit, process start included, measured in CI with `scripts/bench-hook.ts`:

| Platform | p95 |
|---|---|
| Linux | 39 ms |
| Windows | 68 ms |
| macOS | 79 ms |

In real Claude Code sessions on Windows, hook start-up before the request was 31 ms at p50 and 84 ms at p95. The server-side part of the check is under 1 ms (p95 0.47 ms in the first spike).

## What it took

| Variant (Windows, 50 runs) | p50 | p95 |
|---|---|---|
| TypeScript source, run by Node | 166 ms | 172 ms |
| One bundled `.cjs` file | 130 ms | 135 ms |
| Bundled, repository identity cached on disk | 78 ms | 84 ms |
| Bundled, cached, `node:http` instead of `fetch` (CI) | | 68 ms |

- **Repository identity:** working out which repository a file belongs to took two `git` processes per edit, about 24 ms each on Windows. It is now cached on disk and invalidated when the repository's git config changes.
- **`fetch`:** loading it costs about 45 ms in every short-lived hook process. The hook uses `node:http`.

## When a file is held

A held file is not a slow check: the agent waits in a first-come, first-served queue until the lease is free. A lease lasts one edit, so a wait is typically about a second. Under heavy load the wait grows with the number of agents on one hot file; see the [scale test](scale-2026-11-02.md).

## Reproduce

```sh
npm ci && npm run build
node scripts/bench-hook.ts
```
