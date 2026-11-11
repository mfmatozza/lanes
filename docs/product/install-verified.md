# Install guide, verified

> **Status:** Verified 2026-10-31 (VS Code 1.142.0, Windows 10, Node 24, `.vsix` 0.1.0 built from this branch) · **Owner:** @mfmatozza · Issue #252
> Everything marked **verified** was run for real on a clean profile (isolated `--user-data-dir`, `VSCODE_EXTENSIONS`, `LANES_HOME`). Everything marked **unverified** could not be run here and says why.

## What the first run found (before the fixes)

| Documented step | Result | Why |
|---|---|---|
| Hero prompt: `code --install-extension MicheleFMatozza.lanes` | **broken today** | `Extension 'michelefmatozza.lanes' not found`, exit 1. The listing is not live. Expected until the first publish. |
| `code --install-extension lanes-0.1.0.vsix` | works | Exit 0, `michelefmatozza.lanes@0.1.0`; the version in the file name matches `packages/extension/package.json`. |
| Hero prompt: "tell me to run Lanes: Set Up Repository from the Command Palette" | **unusable** | An AI agent cannot open the Command Palette; the human has to. |
| `lanes server --host 0.0.0.0` (site, team note) | **broken** | The `.vsix` held `extension.cjs`, `hook.cjs`, `server.cjs` only: no `lanes` command exists for a user who only installed the extension (`lanes: command not found`). The server's own output also told teammates to run `lanes connect`. |
| Command Palette: `Lanes: Start Local Server`, `Lanes: Set Up Repository` | works | Both titles exist in `contributes.commands`. Starting a server by hand is optional: the first Claude Code session starts one. |
| Teammate sets `lanes.serverUrl` and `lanes.token` in settings | works, but hard | Two machine settings to find by hand, the URL and token typed from memory. |
| `git push` | works | `lanes init` already publishes `lanes/main`; the push sends the setup commit on the user's own branch. |
| Switching Lanes off | **missing** | No `lanes off`; the hooks stayed in `.claude/settings.json`. |

## What changed in the product (PR for #252)

- The `.vsix` now ships `dist/lanes.cjs` (the CLI). Run it with plain `node`; it finds `hook.cjs` and `server.cjs` next to itself.
- New commands: **Lanes: Copy Team Server Command**, **Lanes: Copy Teammate Join Message**, **Lanes: Join Team Server**. The clipboard is written only when the user runs the command, and the token is never written to the Lanes log (tested).
- First run: one notification ("Get Started", "Join a Team Server") instead of a walkthrough tab that opens by itself.
- New `lanes off` (removes hooks and `.lanes/*.cjs`, commits only that; your own hooks stay).
- `lanes server --host` no longer prints a `lanes connect ...` line that needs a `lanes` command; `lanes init` no longer says "Next: `lanes server`".
- No `vscode://` URI handler: it would act on whichever window was last active, so it is not deterministic; the `node <path> init` route is.

Tests: `packages/extension/test/manifest.test.ts` (the `.vsix` ships the CLI and `init` runs from it; every bold `Lanes: ...` command in the READMEs, the walkthrough and this guide is a real command), `activate.test.ts` (copy commands, join, first run, token not logged), `packages/cli/test/install.test.ts` (`off`). The real-agent check is `node scripts/e2e/agent-install.mjs`.

## A. Beta: install the `.vsix`  (verified)

```bash
code --install-extension lanes-0.1.0.vsix          # exit 0: "successfully installed"
code --list-extensions --show-versions             # michelefmatozza.lanes@0.1.0
```
Open the repository folder in VS Code. Then, in the Command Palette: **Lanes: Set Up Repository**, and `git push`. Start Claude Code in the folder.
- Cursor and Windsurf: use the Extensions view, `...` menu, **Install from VSIX**. Their `cursor --install-extension` and `windsurf --install-extension` were **not tested** (not installed here).
- If `code` is not found: VS Code, Command Palette, **Shell Command: Install 'code' command in PATH** (macOS), or reinstall with "Add to PATH" (Windows). Unverified here.
- The `.vsix` is 125 KB, 14 files, and contains `dist/lanes.cjs`.

## B. Marketplace  (unverified until the listing is live: verify after publish)

Expected, by reasoning, not run: `code --install-extension MicheleFMatozza.lanes` (the publisher ID is case-insensitive in the CLI; the failure above shows it already lower-cases it) installs the same package. Cursor and Windsurf use Open VSX (a separate publish, `upload/README.md`); their search finds it only after that publish.

Checks to run in 5 minutes once it is live (fresh dirs, nothing of your own profile):
```bash
mkdir C:/lanes-tmp/live && cd C:/lanes-tmp/live
code --user-data-dir ud --extensions-dir ext --install-extension MicheleFMatozza.lanes     # exit 0
code --user-data-dir ud --extensions-dir ext --list-extensions --show-versions             # version = package.json
ls ext/michelefmatozza.lanes-*/dist/lanes.cjs                                              # the CLI is inside
node ext/michelefmatozza.lanes-*/dist/lanes.cjs --help                                     # prints the usage
```
Then, from the repository: `node scripts/e2e/agent-install.mjs --prompt-file <the live prompt in section C>` (all six checks must say true), open the Marketplace page and check the icon, README, version, links and screenshots (the repository must be public), and install once by searching "Lanes" in the Extensions view. Repeat in Cursor or Windsurf after the Open VSX publish.

## C. Setup from an AI agent prompt  (verified with real `claude -p`, haiku)

The agent cannot use the Command Palette, so the prompt uses the CLI that now ships inside the extension. The hooks start the local server themselves, so no "start server" step is needed.

<!-- prompt:beta -->
```text
Set up Lanes in this repository by running these terminal commands in order. Stop and tell me if one fails (for example if `code` is not found).
1. code --install-extension lanes-0.1.0.vsix
2. Find the file lanes.cjs that the extension installed: <extensions folder>/michelefmatozza.lanes-*/dist/lanes.cjs. The extensions folder is the one in the VSCODE_EXTENSIONS environment variable if it is set, else ~/.vscode/extensions (another editor keeps its extensions in its own folder).
3. From the root of this repository run: node <path of that lanes.cjs> init
Do not run git push yourself (init publishes its own branch lanes/main to origin: that is expected). When done, tell me what was installed and committed, then tell me to reload the editor window (Command Palette: Developer: Reload Window) and to run git push when I am ready.
```

Live variant (after publish): the same text with step 1 `code --install-extension MicheleFMatozza.lanes`. Only that command differs, so the transcript below covers it, except the Marketplace download itself (unverified).

**Transcript summary** (run on 2026-10-31, `node scripts/e2e/agent-install.mjs`: temp repo with a bare origin, isolated `code`, `VSCODE_EXTENSIONS` and `LANES_HOME`, project settings only, haiku, `--allowedTools Bash`): five Bash calls, no questions to the human, no clicks.
1. `code --install-extension <vsix>`: installed.
2. `ls "${VSCODE_EXTENSIONS:-$HOME/.vscode/extensions}"/michelefmatozza.lanes-*/dist/lanes.cjs`: found.
3. `node <that file> init` in the repository root: wrote `.lanes/hook.cjs`, `.lanes/server.cjs`, `.claude/settings.json`, committed `chore: set up Lanes`, created `lanes/main` on origin.
4. Two read-only `git` calls to check, then the final message: what was installed, the commit, that `lanes/main` was already published, an untouched `.vsix`, "reload the window" and "run git push when ready".
Checks after the run, all true: extension in the isolated folder with `dist/lanes.cjs`; hooks in `.claude/settings.json`; setup commit; `lanes/main` on origin; `main` on origin unchanged (the agent did not push). Three real runs, all with every check true. The first two (without the sentence about `lanes/main`) worked, but the agent warned that `init` pushed `lanes/main` "although you said not to push"; the sentence in the final prompt removed that, and the third run (final prompt) was clean with 4 tool calls. Real `~/.claude/settings.json` byte-identical afterwards, no Lanes hooks in it.

## D. A team server on one machine, teammates joining  (verified on one machine; unverified across two)

Host:
1. Install the extension (A or B). In VS Code run **Lanes: Copy Team Server Command**, paste the line in a terminal. It looks like `node ".../michelefmatozza.lanes-0.1.0/dist/lanes.cjs" server --host 0.0.0.0` (needs Node on PATH). It prints the token, the addresses and "listening on http://0.0.0.0:4317".
2. Run **Lanes: Copy Teammate Join Message** and send the message. It has the LAN address and the token: send it only to teammates.
3. Windows or macOS may ask to allow Node through the firewall: allow it on private networks. **Unverified** (no prompt appeared here).

Teammate: install the extension, run **Lanes: Join Team Server**, paste the address and the token. Same thing in a terminal: `node <lanes.cjs> connect --server <url> --token <token>`, then `... status` answers `Lanes: 0 agents ...`.

Verified here, with the server on `0.0.0.0:4398` and a second `LANES_HOME` as the teammate, over this machine's LAN address: no token is refused (exit 1), `connect` saves the address and token to the teammate's config only, `status` then answers, a wrong token is refused. **Not verified:** a second physical machine, a firewall, a VPN.

## E. Uninstall and rollback  (verified)

```bash
node <extensions folder>/michelefmatozza.lanes-*/dist/lanes.cjs off     # in the repository: removes hooks and .lanes/*.cjs, commits that
git push                                                                 # teammates get the removal
code --uninstall-extension MicheleFMatozza.lanes                         # removes the extension
```
`off` keeps your own hooks and settings, deletes `settings.json` only if Lanes was all it held, commits only its own files, and is safe to run twice ("nothing to remove"). Claude Code sessions already open keep their hooks until restarted. Left alone on purpose: the `lanes/main` branch (delete it on origin if you want: `git push origin --delete lanes/main`) and `~/.lanes` (token, config, ledger: delete the folder by hand). Run `off` before uninstalling the extension, because the extension is where the CLI lives.

## Ready-to-paste text for the website

State **soon** (today: the Marketplace listing is not live). State **live** differs only where marked.

**Hero, setup prompt box** (soon):
```text
Set up Lanes in this repository by running these terminal commands in order. Stop and tell me if one fails (for example if `code` is not found).
1. code --install-extension lanes-0.1.0.vsix
2. Find the file lanes.cjs that the extension installed: <extensions folder>/michelefmatozza.lanes-*/dist/lanes.cjs. The extensions folder is the one in the VSCODE_EXTENSIONS environment variable if it is set, else ~/.vscode/extensions (another editor keeps its extensions in its own folder).
3. From the root of this repository run: node <path of that lanes.cjs> init
Do not run git push yourself (init publishes its own branch lanes/main to origin: that is expected). When done, tell me what was installed and committed, then tell me to reload the editor window (Command Palette: Developer: Reload Window) and to run git push when I am ready.
```
Small text under it (soon): `Paste into Claude Code, in the folder of your repository, next to the lanes-0.1.0.vsix file we sent you (give Claude the full path if it is elsewhere). It needs Node.js and git on your PATH.`
Live: step 1 becomes `code --install-extension MicheleFMatozza.lanes`; small text: `Paste into Claude Code, in the folder of your repository. It needs Node.js and git on your PATH.`

**Install section, card 1, "Install the extension"** (soon, badge Beta): text `Beta teams receive the extension file. Install it from a terminal. In Cursor and Windsurf use Extensions, "...", Install from VSIX.` Command: `code --install-extension lanes-0.1.0.vsix`
Live (no badge): text `Install it from the Extensions view (search "Lanes") or from a terminal. Cursor and Windsurf find it in their own extension store.` Command: `code --install-extension MicheleFMatozza.lanes`

**Card 2, "Set up the repository"** (once): text `Open the repository in VS Code and run this in the Command Palette. It adds the hook and commits it. Working alone, nothing else to start: the first Claude Code session starts the local server.` Block: `Lanes: Set Up Repository`
(Remove `Lanes: Start Local Server` from the site: it is optional now.)

**Card 3, "Push, then work as usual"**: text `Teammates install the extension and pull. Start Claude Code in the repository and its agent shows up in the Lanes view within a second.` Command: `git push`

**Team note** (replaces the `lanes server --host 0.0.0.0` sentence):
`Working with a team? One person runs "Lanes: Copy Team Server Command" and pastes the line in a terminal on one machine (Node.js required), then "Lanes: Copy Teammate Join Message" and sends it to the team. Everyone else runs "Lanes: Join Team Server" and pastes the address and token. Your edits always go ahead, whatever state Lanes is in.`

**Card "Self-host for free"**: the command shown there, `lanes server --host 0.0.0.0`, is not available to a user who only installed the extension. Replace it with `Lanes: Copy Team Server Command` (a Command Palette entry), or with the full line `node ~/.vscode/extensions/michelefmatozza.lanes-0.1.0/dist/lanes.cjs server --host 0.0.0.0` (the version number changes with every release, so the first is safer).

**FAQ, "How do I turn it off?"**: `In your repository run "node <extensions folder>/michelefmatozza.lanes-*/dist/lanes.cjs off", then git push. Then uninstall the extension from the Extensions view. Your edits are never blocked either way.`

Other fixes for the web agent: the claim "Cursor, Windsurf and other forks install the same file" is only true for Install from VSIX (their command-line installers are untested); the site's "Lanes: offline" is a real status bar text; every other `Lanes: ...` title on the site matches the manifest (checked: `Lanes: Set Up Repository`, `Lanes: Start Local Server`).

## Not verified, and why

- Cursor, Windsurf, VSCodium: not installed here (command-line installers and the extension folders `~/.cursor/extensions`, `~/.windsurf/extensions`).
- Marketplace and Open VSX installs: not published.
- macOS, Linux, Remote - SSH, WSL, Dev Containers; VS Code 1.95.
- A team server across two machines and a firewall.
- A real person clicking the first-run notification: its look was checked in a real VS Code window, its buttons by test.
- `code --install-extension` into an already running window: the extension may need **Developer: Reload Window** to start (the prompt says so).
