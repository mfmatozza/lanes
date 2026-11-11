# Documentation guide

> **Status:** Approved · **Owner:** @mfmatozza · **Last updated:** 2026-10-22
> [Docs](../README.md) › Engineering › Documentation guide · [← Release process](release-process.md)

## Principles
- **Docs live in the repository**, as Markdown, and are reviewed in PRs like code.
- **Docs come before code** for anything user-facing or architectural.
- **One topic, one page.** Link to other pages instead of repeating them.

## Every page has
1. An H1 title.
2. A metadata block:
   ```markdown
   > **Status:** Draft · **Owner:** @handle · **Last updated:** YYYY-MM-DD
   > [Docs](../README.md) › Section › Page · ← Previous · Next →
   ```
3. Statuses: **Draft** (being written) → **In review** (open PR asking for approval) → **Approved** (team agrees) → **Outdated** (needs an update; open an issue).

## Navigation rules
- Every new page is added to the [documentation index](../README.md) in the same PR.
- Use relative links only. Check them before merging (a CI link checker is planned).
- Diagrams use **Mermaid**, which GitHub renders natively, so diagrams can be diffed.

## Style
- Plain, direct English. Short sentences. Prefer tables and lists to long paragraphs.
- Use only terms from the [Glossary](../product/glossary.md).
- Mark claims that come from outside sources with a link. Mark unverified claims *(unverified)*.
