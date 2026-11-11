# ADR-0025: Task titles from prompts are opt-in per repository

- **Status:** Proposed
- **Date:** 2026-10-26
- **Deciders:** @mfmatozza
- **Related:** [ADR-0018](0018-automatic-tasks-and-overlap.md) · [ADR-0023](0023-security-baseline.md) · [Security model](../architecture/security.md) · Phase 4 plan · issue #172

## Context
When a person sends a prompt, the hook derives a **task title** from its first line (up to 120 characters, with secrets redacted) and today **sends it by default** ([ADR-0018](0018-automatic-tasks-and-overlap.md); `packages/hook/src/hook.ts`). The title then:
- goes to the team's coordination server, which shows it in the Agents view and the task board, so teammates can see what each agent is doing;
- is used in commit messages on `lanes/main`, which is pushed to the team's git remote and stays in history.

Opting out exists only as the environment variable `LANES_NO_PROMPT_TEXT=1`, which makes the title "Agent task". Nothing in the product asks, and the user may not know. The [security model](../architecture/security.md) is honest that "free text cannot be redacted reliably". Prompts can contain secrets, customer names, or personal data about colleagues.

What does **not** happen: titles never reach us (the company). The privacy policy's "we never receive your prompts" stays true. The exposure is to teammates and to the git remote, which are the same trust domain as the code.

The title is the part of Lanes that makes the views useful: "Bea: refactor the auth middleware" versus "Bea: Agent task". It is also what overlap detection shows to humans.

## Decision
Proposed: **titles are opt-in, decided once per repository, with the choice shown at setup.**
- **Default: off.** The title is "Agent task" in the views and in commits.
- **Choice at setup:** **Lanes: Set Up Repository** and `lanes init` ask one question in plain words: "Show what each agent is working on (the first line of the prompt, secrets removed) to your teammates and in the shared git history?" with the effect of each answer. The answer is stored in the repository's committed Lanes settings, so the team chooses together and a new member inherits it.
- **Per-person override stays:** `LANES_NO_PROMPT_TEXT=1` (and a matching extension setting) can only make it stricter for one person, never looser.
- **Two surfaces, one switch in the beta.** If the beta shows that people want the title in the views but not in git history, split them in a later ADR.
- The design-partner onboarding (plan §6.3) explains the question and recommends "on" for teams that trust their own remote.
- Existing installs (the dogfooding repository) are asked once on the next Set Up.

## Alternatives considered
| Option | Pros | Cons |
|---|---|---|
| **A: Opt-in per repository, asked at setup (proposed)** | Privacy by default; the team decides once; no surprise in git history; matches the "never leaves your machines" promise | Teams that click through get a less informative board; one more question during setup |
| B: Opt-out (today's behaviour), documented and made visible | Best out-of-the-box usefulness; fewer setup questions | A prompt's first line can end up in permanent git history without a conscious choice; weak under GDPR privacy by default (art. 25) if the prompt names a person; one wrong redaction is a data incident |
| C: Never send titles (task text is always neutral) | Simplest and safest | Loses most of the value of the task board and overlap view |
| D: Server-only titles, never in commits | Ephemeral exposure only (the server is in memory) | Commit messages lose context; attribution (ADR-0017) is unaffected, but history is less readable; needs the title kept out of the commit path, which is a code change |

## Consequences
- **Positive:** a clear answer to "who can see my prompt?"; the privacy policy, security model and onboarding say the same thing; no change to what we receive.
- **Negative / trade-offs:** the default board looks less informative at first sight; some teams will not turn it on. **Measure it:** share of beta repositories with titles on (from the `lanes report` summaries teams choose to send). **Revisit trigger:** fewer than half of reporting teams turn it on and written feedback says the board is "not useful" (then consider D as the default).
- **Follow-ups:** implement #172; update [security.md](../architecture/security.md) (it currently says titles are on by default) and the privacy policy table; add a test that with the setting off no prompt text reaches the server or a commit message; update ADR-0018's consequences to point here.
