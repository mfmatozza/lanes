# ADR-0026: Protected open core: Apache-2.0 for the clients, source-available for the server, closed for the paid product

- **Status:** Superseded by [ADR-0032](0032-apache-2-for-everything.md) on 2026-11-11 (Apache-2.0 for everything)
- **Date:** 2026-10-28
- **Deciders:** @mfmatozza
- **Related:** [ADR-0013](0013-open-core.md) (superseded in part) · Business model · Competitive positioning · Terms · Phase 4 plan · issue #221

## Context
- [ADR-0013](0013-open-core.md) chose open core and Apache-2.0 for every open part, including the basic local server. It is Accepted and stays as history.
- The founder asked "if someone can self-host, why would they ever pay?" and does not want the paid product to end up 100% open source ("maybe at the beginning it can be open source or open core").
- Apache-2.0 on the server lets anyone, including a funded competitor, run it as a hosted service and sell it, with our own code. The terms page said the opposite ("may not offer as a competing hosted service"), which an Apache-2.0 licence cannot say. The two texts disagreed.
- The parts differ in how much trust they need. The hook runs inside customers' repositories and the extension runs in their editor, so people want to read them, and they are useless without a server. The server is where hosted competition would happen.

## Decision
Proposed: a **protected open core**, in four layers.

| Layer | What | Licence | Why |
|---|---|---|---|
| **A. Open clients** | Hook, VS Code extension, protocol spec, shared core library (`@lanes/core`) | **Apache-2.0** (patent grant suits enterprise adoption) | Trust and adoption; they only work with a server, so they do not enable a competing hosted product by themselves |
| **B. Source-available server** | The coordination server, including the basic local one used by the Community tier | **Functional Source License, FSL-1.1-Apache-2.0**: free for internal use, self-hosting and non-competing purposes; **forbids offering a competing hosted product**; each release **converts to Apache-2.0 two years after it is published** | Teams can read it, run it and self-host it for free, which is the Community promise. Nobody can resell it as a hosted competitor |
| **C. Closed** | The hosted multi-team service, conflict prediction, symbol-level leases, merge queue, history and analytics, audit log, policies, SSO, SLA | Commercial terms, **private repository** | The product people pay for. Open packages never import it |
| **D. Name and logo** | "Lanes", the logo | **Trademark policy**: forks and hosted services may not use the name or logo | Licences do not cover names; this is what stops a look-alike hosted service |

**Older server versions become Apache-2.0 after the conversion date.** That is acceptable: what makes the paid product valuable lives in layers C and D and keeps moving; a two-year-old basic server is a free-tier server by definition.

### FSL or BUSL
| | **FSL-1.1-Apache-2.0** (proposed) | **BUSL-1.1 with an Additional Use Grant** |
|---|---|---|
| What it forbids | Competing use, defined in the licence text | Whatever the Additional Use Grant leaves out; we would write that text ourselves, and the lawyer would have to check it |
| Conversion | Fixed: 2 years after each release, to Apache-2.0 | Chosen per release: up to 4 years, to a GPL-compatible licence of our choice |
| Standard text | Yes, a short fixed template used by other companies; little to negotiate | Yes, but the grant is bespoke, so more legal work and more chance of ambiguity |
| Developer trust | Better known as "fair source", plainly worded | Known, but "BSL" has a name for scaring people after other vendors' changes |
| Open source? | **No.** Not OSI-approved, and we must never call the server "open source" | **No**, same |
| Our flexibility | Less | More (longer clock, custom grant) |

**Recommendation: FSL-1.1-Apache-2.0**, for the shorter text, the fixed and shorter conversion clock, and the lower legal cost. Choose BUSL only if the lawyer says the competing-use definition in FSL does not cover our case.

### Wording consequences
- The server is described as **source-available**, never "open source". The open-source claim applies only to layer A.
- Community is "free to use and self-host", not "open source".
- The repository stays private until the founder decides to publish; public release is then a licensing step (checklist below).

### Contributors
- **Layer A (Apache-2.0):** a Developer Certificate of Origin sign-off (DCO) is enough.
- **Layer B (FSL):** contributors need a **contributor licence agreement (CLA)**, because we need the right to relicense and to offer the code under the commercial terms. Until a CLA exists, **do not accept outside contributions to the server**.
- The lawyer decides the final text (#159).

### Trademark policy
A short page in the public repository: what anyone may do (say they are compatible with Lanes, link to us) and may not (use the name or logo for a fork, a hosted service or a product). The name must first clear the trademark search (#156); the policy comes after.

## Alternatives considered
| Option | Pros | Cons |
|---|---|---|
| **Protected open core (proposed)** | Trust where it matters; the server is readable and free to self-host; blocks hosted copycats; the moat stays closed | The server is not open source, so some developers will not adopt it; needs a CLA for server contributions; a licence text to get reviewed; the two-year conversion is irreversible per release |
| ADR-0013 as written (Apache-2.0 for every open part) | Maximum trust and adoption, simplest | Any hosted competitor can run the server; the founder does not want this; the moat is the unbuilt closed features only |
| BUSL-1.1 instead of FSL | Longer clock, custom grant | More legal work and a bespoke text; see the table |
| **Fully closed source, with a free tier** (fallback) | Maximum control; nothing to protect with licences; no CLA or conversion | Security-minded teams cannot read the server; the hook and extension are readable JavaScript anyway, so the trust gain of openness is partly lost; no community contributions |
| Fully open source (everything Apache-2.0, including the closed features) | Maximum goodwill | Gives away the paid product; rejected |

### When the fallback (start fully closed) would be better
- The lawyer finds the FSL competing-use clause unenforceable or too uncertain in our jurisdictions, and BUSL has the same problem.
- Beta teams do not care about reading the server, and the hook and extension being open is enough for trust.
- A competitor forks the Apache parts before the server licence is in place.
- Nobody wants to contribute and the CLA is pure friction.
In that case: keep layer A open only if it costs nothing, close everything else, keep Community free, and revisit opening later. Opening later is easy; closing later is not.

## Consequences
- **Positive:** a clear answer to "why pay": the paid product is not open, the server cannot be resold as a hosted competitor, and the name is protected. The site, terms and manifest can finally say the same thing.
- **Negative / trade-offs:** some developers will not touch non-OSI software; Open VSX and Marketplace listings must declare the extension (layer A) correctly; the Apache protocol spec lets a third party write a **clean-room competing server**. We accept that: the closed features, the hosted service and the name are what protects us.
- **Revisit trigger:** a competitor hosts the open server or a clone of it and takes users; the lawyer's opinion; or beta signals (pricing validation) show that trust in reading the server does not matter.
- **Follow-ups (public release checklist, only when the founder decides to publish):**
  1. A `LICENSE` file per package: Apache-2.0 for `core`, `hook`, `extension` and the protocol spec; FSL-1.1-Apache-2.0 for `server` (with the year and licensor filled in).
  2. Source headers (SPDX identifiers) per package.
  3. Decide DCO for layer A and CLA for layer B.
  4. Publish the trademark policy and the `SECURITY.md`.
  5. Check that no layer A package imports layer B or C, and that the closed features live only in the private repository.
  6. The lawyer confirms the licence texts, the competing-use definition and the terms (#159).
- **Documents changed with this ADR:** ADR-0013 (a pointer, history kept), business model, the terms and the site FAQ, the extension `LICENSE.txt` placeholder and manifest, the upload guide, [repository structure](../engineering/repository-structure.md) and the Phase 4 plan.
