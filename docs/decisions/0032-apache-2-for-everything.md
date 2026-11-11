# ADR-0032: Apache-2.0 for everything in the public repository

- **Status:** Accepted
- **Date:** 2026-11-11
- **Deciders:** @mfmatozza
- **Related:** supersedes [ADR-0026](0026-protected-open-core-licence.md) and the licence part of [ADR-0013](0013-open-core.md)

## Context
- ADR-0026 proposed a split: Apache-2.0 for the hook, the extension, the protocol and the shared library, a source-available licence (FSL-1.1) for the server, and closed code for a paid hosted product.
- On 11 November 2026 the founder decided to publish Lanes 0.3.0 as free, open source software in one public repository, with no paid plan on sale and no hosted product built. A source-available server would make the repository "partly open source" and would need explaining in every README and listing.
- Nothing in the repository is sold today. The hosted server and the paid features in ADR-0026 are not built.

## Decision
- Every package in the public repository, the server included, is licensed under Apache-2.0. One `LICENSE` file at the root; every `package.json` says `"license": "Apache-2.0"`; the extension's `LICENSE.txt` is the same text.
- The site, the beta sign-up API and the private planning documents stay in the private repository and are not published.
- If a hosted product is built later, it is a separate service with its own terms. This ADR does not decide anything about it.

## Consequences
- Anyone may run, change and redistribute Lanes, including as a hosted service. That is accepted.
- The terms page and any listing must never describe the server as anything other than open source.
- ADR-0026 is kept as history with its status set to Superseded. ADR-0013's choice of open core stays as history; its licence choice (Apache-2.0 for the open parts) is now the choice for all parts.
