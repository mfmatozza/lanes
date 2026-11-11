# Release process

> **Status:** Approved · **Owner:** @mfmatozza · **Last updated:** 2026-10-26
> [Docs](../README.md) › Engineering › Release process · [← Testing strategy](testing-strategy.md) · [Documentation guide →](documentation-guide.md)

## Versioning
- [SemVer](https://semver.org). `0.x` until the public launch: minor versions may break things, and the changelog says so.
- The extension, server and hook share **one version number**. The server reports it from `/health`, and the hook sends it on each request, so mismatches can be detected.
- The protocol version (`/v1`) is independent of the product version and only changes through an ADR.

## Steps
1. Open a **release issue** from the checklist template: changelog, the manual test checklist, end-to-end run results.
2. Bump the version, update `CHANGELOG.md`, and open a PR titled `chore(release): vX.Y.Z`.
3. After merging, tag `vX.Y.Z`. CI then:
   - builds and runs the full test matrix;
   - runs `vsce package` and attaches the `.vsix` to the GitHub Release;
   - publishes to the VS Code Marketplace (`vsce publish`) and Open VSX (`ovsx publish`) **only for non-preview tags**.
4. Pre-releases (beta): `vsce publish --pre-release`.

## Tooling notes
- `@vscode/vsce` is the packaging CLI. Publishing needs a Marketplace publisher and a token, stored as a CI secret.
- Until the hook-script hash check is in place, users re-run **Set Up Workspace** after each release to refresh their committed `.lanes/hook.cjs`.

## Private beta (Phase 4)
The beta release train (weekly pre-releases on odd minors `0.3.x`, both registries, rollback order, secrets handling) and the incident runbook are in the Phase 4 plan. The draft publish workflow is [`publish-workflow.draft.yml`](publish-workflow.draft.yml).
