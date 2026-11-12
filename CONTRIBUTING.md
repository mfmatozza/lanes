# Contributing to Lanes

Thanks for helping. Bug reports, fixes and docs are all welcome.

## Set up

You need Node.js 24 (22.18 or newer works) and git.

```sh
npm ci
npm run typecheck
npm test
npm run build
```

`npm run build` writes `dist/hook.cjs`, `dist/server.cjs` and `dist/lanes.cjs`, and the extension bundle in `packages/extension/dist/`. Run the CLI from the build with `node dist/lanes.cjs --help`. Package the extension with `npm run package`.

## How the packages fit

| Package | What it is |
|---|---|
| `packages/core` | Shared types, repository identity, settings, the adapters for each agent |
| `packages/hook` | The hook every agent runs at each event: leases, sync and publish to `lanes/main` |
| `packages/server` | The coordination server: leases, queue, tasks, the snapshot stream and the browser app |
| `packages/team` | Team context: the brief, the heads-up, chat and requests |
| `packages/cli` | The `lanes` command, including `lanes mcp` |
| `packages/extension` | The VS Code extension. It bundles the hook, the server and the CLI |

The TypeScript runs directly on Node (type stripping), so there is no compile step for tests. Architecture and the reasons behind it: [docs/architecture](docs/architecture/overview.md) and [design decisions](docs/design.md).

## Pull requests

1. Open an issue first for anything bigger than a small fix.
2. Use [Conventional Commits](https://www.conventionalcommits.org): `fix(hook): ...`, `feat(server): ...`, `docs: ...`.
3. Add or update tests. `npm run typecheck` and `npm test` must pass. CI runs them on Linux and Windows, and on macOS for `main`.
4. If your change affects a doc, update the doc in the same pull request. A change to how Lanes works gets a paragraph in [docs/design.md](docs/design.md): the decision, why, and what it costs.
5. Sign off every commit (Developer Certificate of Origin, [developercertificate.org](https://developercertificate.org)). `git commit -s` adds the line:

   ```
   Signed-off-by: Your Name <you@example.com>
   ```

By contributing you agree that your contribution is licensed under [Apache-2.0](LICENSE).
