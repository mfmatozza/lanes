# ADR-0001: Record decisions as ADRs

- **Status:** Accepted
- **Date:** 2026-10-22
- **Deciders:** @mfmatozza

## Context
We're a small team making many foundational decisions quickly. Without a written record, the reasons behind those decisions get lost and get argued again. New contributors also need to understand *why* things are the way they are.

## Decision
- Every significant decision gets an ADR in `docs/decisions/`, numbered in order, using the [template](template.md).
- ADRs are proposed through pull requests. Merging with status `Accepted` means the team agrees.
- An ADR is never rewritten after it has been accepted. Instead, a new ADR supersedes it.

**Significant** means any of the following: it's hard to reverse; it changes the protocol, the data model, the security posture or the product scope; or it picks a major dependency.

## Consequences
- Small overhead per decision; a durable record of our reasoning.
- The [decision log](README.md) must be kept up to date in the same PR.
