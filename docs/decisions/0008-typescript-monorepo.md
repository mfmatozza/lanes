# ADR-0008: TypeScript monorepo (npm workspaces, esbuild)

- **Status:** Accepted
- **Date:** 2026-10-22
- **Deciders:** @mfmatozza
- **Related:** [Repository structure](../engineering/repository-structure.md)

## Context
- VS Code extensions are written in TypeScript or JavaScript.
- The hook and the extension must identify files *the same way*, so they should share code.
- The server is small and benefits from sharing types with its clients.

## Decision
- **One repository** with npm workspaces: `core`, `server`, `hook` and `extension`.
- Everything is TypeScript, in strict mode.
- **esbuild** bundles the extension, server and hook into the extension's `dist/`.
- **tsc** (`--noEmit`) does type-checking.
- Tests use the **built-in Node test runner** (`node --test`), running TypeScript directly through Node's type stripping (Node ≥ 22.18 / 24).

## Alternatives considered
| Option | Pros | Cons |
|---|---|---|
| **TS monorepo + esbuild + node:test (chosen)** | One language; shared code; few dependencies; fast builds | Type stripping rules out enums and parameter properties |
| Server in Go or Rust | Performance | Two languages; types duplicated; overkill for the load |
| pnpm or Turborepo | Faster installs, caching | More tooling than we need now |
| Jest or Vitest | Richer features | Extra dependencies; node:test is enough |

## Consequences
- Code must stick to type syntax that can simply be stripped out (`erasableSyntaxOnly`).
- Node ≥ 22.18 is required for development.
