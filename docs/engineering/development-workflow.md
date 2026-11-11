# Development workflow

> **Status:** Approved · **Owner:** @mfmatozza · **Last updated:** 2026-10-22
> [Docs](../README.md) › Engineering › Development workflow · [Repository structure →](repository-structure.md)

## 1. Planning
- **Every piece of work has a GitHub issue.** Use the templates: *Feature*, *Bug*, *Decision*.
- Issues belong to a **milestone** that matches a roadmap phase (e.g. `Phase 2 – Spike`).
- Labels:
  - Area: `area:server`, `area:hook`, `area:extension`, `area:core`, `area:docs`
  - Type: `type:feature`, `type:bug`, `type:decision`, `type:chore`
  - Priority: `priority:must`, `priority:should`, `priority:could`
- Feature issues reference their requirement ID from the [PRD](../product/requirements.md) (e.g. `C1`) and list acceptance criteria.

## 2. Branches
- `main` is always releasable and protected: changes go in only through pull requests, and CI must pass.
- Branch names: `<type>/<issue>-<short-slug>`, e.g. `feat/12-lease-ttl`, `fix/31-windows-paths`, `docs/4-protocol`.

## 3. Commits
[Conventional Commits](https://www.conventionalcommits.org): `feat(server): renew leases on report`, `fix(hook): normalize Windows drive letters`, `docs(adr): accept ADR-0006`.

## 4. Pull requests
- Use the [PR template](../../.github/pull_request_template.md). Link the issue (`Closes #12`).
- Small PRs: aim for under 400 changed lines.
- **At least one approving review** before merging. The author merges with squash.
- If a PR changes behaviour described in the docs, it **updates those docs in the same PR**.
- If a PR makes a significant decision, it **adds an ADR** ([ADR-0001](../decisions/0001-record-architecture-decisions.md)).

## 5. Definition of done
- [ ] Acceptance criteria in the issue are met.
- [ ] Tests added or updated and passing ([testing strategy](testing-strategy.md)).
- [ ] Type-check and lint are clean.
- [ ] Docs and ADRs updated, with each doc's "Last updated" date bumped.
- [ ] Manually verified on at least one OS. Changes to the hook or path handling are verified on both Windows and macOS or Linux.
- [ ] Reviewed and approved.

## 6. Working with AI agents (we use our own medicine)
- Agents may open PRs, but a human owns and reviews every PR.
- Once the MVP exists, run agents with Lanes enabled on this repository.
- Commits written with an agent include a `Co-Authored-By:` trailer.
