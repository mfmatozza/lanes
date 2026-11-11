# ADR-0013: Open core, made public at the private beta

- **Status:** Accepted. **Superseded in part by [ADR-0026](0026-protected-open-core-licence.md)** (proposed): the licence of the coordination server and the trademark policy. The open-core split and the closed moat stand.
- **Date:** 2026-10-22
- **Deciders:** @mfmatozza
- **Related:** issue #5, Business model, [Security model](../architecture/security.md)

## Context
- The hook script runs inside customers' repositories and decides which edits their agents may make. Security-minded teams will want to read it.
- The extension ships as readable JavaScript anyway.
- Our moat is the coordination intelligence: conflict prediction, symbol-level leases and the merge queue. It isn't the basic local server.
- Our free tier costs us $0 because it's self-hosted.

## Decision
**Open core.**

| Open source (Apache-2.0) | Closed (commercial) |
|---|---|
| Hook script, VS Code extension, protocol spec, shared core library, the basic local coordination server (Community tier) | The hosted multi-team service, conflict prediction, symbol-level leases, merge queue, history and analytics, and Business/Enterprise features (audit log, policies, SSO, SLA) |

- **Timing:** the repository stays **private until the private beta** (Phase 4). The open parts are published then. Commercial code lives in a separate private repository from the start, so no history needs cleaning.
- **Licence:** Apache-2.0 for the open parts, because its patent grant suits enterprise adoption.

## Alternatives considered
| Option | Pros | Cons |
|---|---|---|
| **Open core (chosen)** | Trust where it matters (code that runs locally); growth through GitHub; the moat stays closed | We must maintain the line between free and paid |
| Fully open source | Maximum trust and adoption | Competitors can copy the moat |
| Source-available (FSL/BSL) | Blocks copycat hosted offerings | Developers trust it less |
| Fully closed | Maximum control | Not achievable for client code; hurts trust |

## Consequences
- Keep the split clean in the code: open packages must never import commercial code.
- Add `LICENSE` (Apache-2.0) to the open repository at the beta.
- Contributions to open parts will need a contributor agreement (DCO) policy. Decide it before going public.
