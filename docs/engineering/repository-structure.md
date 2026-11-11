# Repository structure

> **Status:** Approved · **Owner:** @mfmatozza · **Last updated:** 2026-10-24
> [Docs](../README.md) › Engineering › Repository structure · [← Workflow](development-workflow.md) · [Testing strategy →](testing-strategy.md)

Follows [ADR-0008](../decisions/0008-typescript-monorepo.md).

```text
lanes/
├── README.md
├── CONTRIBUTING.md
├── package.json              # npm workspaces + root scripts
├── tsconfig.json             # strict, noEmit, erasableSyntaxOnly
├── scripts/
│   └── build.mjs             # esbuild: extension, server, hook → packages/extension/dist
├── docs/                     # ← you are here
├── .github/                  # issue/PR templates, CI workflows
└── packages/
    ├── core/                 # @lanes/core: shared, no VS Code dependency
    │   └── src/
    │       ├── types.ts          # protocol types (Agent, Lease, Snapshot, requests)
    │       ├── repo.ts           # repository ID + repo-relative path resolution
    │       ├── claudeSettings.ts # merge Lanes hooks into .claude/settings.json
    │       └── config.ts         # ~/.lanes/config.json read/write
    ├── server/               # @lanes/server: coordination server
    │   ├── src/{coordinator.ts, server.ts, main.ts}
    │   └── test/
    ├── hook/                 # @lanes/hook: Claude Code hook script → dist/hook.cjs
    │   ├── src/hook.ts
    │   └── test/
    └── extension/            # VS Code extension (published as "lanes")
        ├── src/{extension.ts, client.ts, agentsView.ts, decorations.ts,
        │        statusBar.ts, localServer.ts, setup.ts}
        ├── media/lanes.svg
        └── package.json      # contributes: views, commands, settings
```

> **Status 2026-10-24:** `core`, `server` and `hook` exist, ported from `spike/` ([ADR-0020](../decisions/0020-port-the-spike.md)); `spike/` stays as the frozen reference and scenario runner until a.9. Packages are imported as `@lanes/core/<file>.ts` (npm workspaces, no build step for tests: Node runs the TypeScript directly). `npm run build` writes `dist/hook.cjs` and `dist/server.cjs`; the extension and `lanes` CLI come next.

## Licences per package (proposed, [ADR-0026](../decisions/0026-protected-open-core-licence.md))
The repository is private until the founder decides to publish. The licence of each package when it does:

| Package | Licence | Notes |
|---|---|---|
| `packages/core`, `packages/hook`, `packages/extension`, the protocol spec | Apache-2.0 (open source) | DCO sign-off for contributions |
| `packages/server` | FSL-1.1-Apache-2.0 (source-available, **not** open source) | Converts to Apache-2.0 two years after each release; a CLA is needed before accepting outside contributions |
| Paid and hosted features (conflict prediction, symbol leases, merge queue, history, audit, policies, SSO, the hosted service) | Closed | A **separate private repository**; no open package imports it |

Publishing is a licensing step, not just a visibility switch: a `LICENSE` file and SPDX headers per package, the DCO and CLA decision, a trademark policy and a `SECURITY.md` (checklist in the ADR).

## Root scripts

| Script | Does |
|---|---|
| `npm run build` | Bundle everything with esbuild |
| `npm run typecheck` | `tsc --noEmit` across all packages |
| `npm test` | `node --test` across all packages |
| `npm run server` | Run the server from source |
| `npm run package` | Build plus `vsce package` → `.vsix` |
