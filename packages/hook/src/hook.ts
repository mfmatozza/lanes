// Claude Code hook: `node hook.ts <prompt|start|pre|post|stop|end|observe>`, hook JSON on stdin.
// Everything here runs in the background of the agent's turn; nothing is shown to the user (ADR-0016).
// See docs/architecture/agent-integration.md and docs/plans/phase-2b-spike-v2.md.
import { spawn } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { redactSecrets } from "./redact.ts";
import { antigravityContext, fromAntigravity } from "./agents/antigravity.ts";
import { changedPaths, changedRanges, checkpointAndPublish, markEditInFlight, mergeStaleWrite, fileHash, filesFromTurn, isAncestor, isOwnPublished, listFiles, syncFromIntegration, tryGit, type Identity } from "./gitops.ts";
import { isLoopback as isLocal, loadConfig, loadOrCreateToken, privateDir, tokenFor, withLock, type Config } from "@lanes/core/local.ts";
import { appendLedger, takeUnreported } from "@lanes/core/ledger.ts";
import { findRepo, locate, teamContextOn, type RepoInfo } from "@lanes/core/repo.ts";
import type { AcquireResponse, LineRange, Task } from "@lanes/core/types.ts";
import { copilotContext, fromCopilot, isCopilotClaudeFormat, isCopilotCloud } from "./agents/copilot.ts";
import { fromKiro, kiroContext } from "./agents/kiro.ts";
import { importsOf } from "./imports.ts";

type HookEvent = "prompt" | "start" | "pre" | "permission" | "post" | "stop" | "end" | "observe" | "read";
const EVENTS: readonly string[] = ["prompt", "start", "pre", "permission", "post", "stop", "end", "observe", "read"];
// How long a publish waits for the repository's own commit hooks (husky, scanners) before it moves on (#81).
const COMMIT_DEADLINE_MS = process.env.LANES_COMMIT_DEADLINE_MS ? Number(process.env.LANES_COMMIT_DEADLINE_MS) : undefined;
// The server accepts this many paths per publish (#101). shortcut: files beyond it get no recorded version; raise it with the server cap.
const MAX_REPORTED_PATHS = 5_000;
// Longest a publish waits for another publish of the same checkout; a dead owner's lock is taken over at once (#110).
// 20 s: six parallel edits of one checkout on a loaded machine queue for longer than 5 s, and a hook that gives up waiting runs unlocked and collides (#141).
const LOCK_WAIT_MS = Number(process.env.LANES_LOCK_WAIT_MS ?? 20_000);
// One git writer per checkout: publishes and syncs (rebase, fetch into the tracking ref) share this lock, or they collide on
// index.lock and ref locks and an edit stays unpublished (#143).
export const checkoutLock = (root: string) => `publish-${crypto.createHash("sha1").update(root).digest("hex").slice(0, 16)}`;
// How long a lease survives while its user decides whether to approve the edit.
const APPROVAL_HOLD_MS = 30 * 60_000;
// The in-flight mark of a whole Cursor turn (a file named "(turn)" at the repository root would share it; harmless).
const CURSOR_TURN = "(turn)";
// Below undici's 300 s response timeout. Leases last one edit, so real waits are seconds (spike v2: max 40 s, at TTL expiry).
const ACQUIRE_WAIT_MS = Number(process.env.LANES_WAIT_MS ?? 240_000);

export interface HookInput {
  session_id?: string;
  cwd?: string;
  prompt?: string;
  tool_name?: string;
  tool_input?: { file_path?: string; notebook_path?: string; command?: string; old_string?: string; edits?: { old_string?: string }[] };
  stop_hook_active?: boolean;
}

export { loadConfig };

export { redactSecrets };
const COMMIT_ID = /^[0-9a-f]{40,64}$/;

// node:http, not fetch: loading fetch costs ~45 ms per hook process, half the latency budget (spike v3).
// shortcut: plain http only; the MVP adds https when the server leaves the LAN.
async function post<T>(config: Config, route: string, body: unknown, timeoutMs: number): Promise<T> {
  // A local server always requires the per-user token (security review); it is created on first use.
  const token = tokenFor(config);
  try {
    return await request<T>(config.serverUrl + route, token, body, timeoutMs);
  } catch (err) {
    // Server down is the one case where coordination stops (spike v3 risk). A local one is simply started.
    if ((err as NodeJS.ErrnoException).code !== "ECONNREFUSED" || !isLocal(config.serverUrl) || process.env.LANES_AUTOSTART === "0") throw err;
    await startLocalServer(config.serverUrl, token ?? loadOrCreateToken());
    return request<T>(config.serverUrl + route, token, body, timeoutMs);
  }
}

/** Starts the local server in the background; it exits by itself after 30 idle minutes. Waits until it answers. */
async function startLocalServer(serverUrl: string, token: string): Promise<void> {
  const here = path.dirname(process.argv[1]);
  const bundled = path.join(here, "server.cjs");
  // Installed: server.cjs sits next to hook.cjs. From source: the sibling package.
  const main = process.env.LANES_SERVER_MAIN ?? (fs.existsSync(bundled) ? bundled : path.join(here, "..", "..", "server", "src", "main.ts"));
  const env = { ...process.env, LANES_PORT: new URL(serverUrl).port || "4317", LANES_TOKEN: token, LANES_IDLE_EXIT_MS: process.env.LANES_IDLE_EXIT_MS ?? String(30 * 60_000) };
  spawn(process.execPath, ["--no-warnings", main], { detached: true, stdio: "ignore", windowsHide: true, env }).unref();
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 100));
    const up = await new Promise<boolean>((resolve) => {
      http.get(serverUrl + "/health", (res) => resolve(res.statusCode === 200)).on("error", () => resolve(false));
    });
    if (up) return;
  }
}

function request<T>(url: string, token: string | undefined, body: unknown, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const data = JSON.stringify(body);
    const headers: http.OutgoingHttpHeaders = { "content-type": "application/json", "content-length": Buffer.byteLength(data) };
    if (token) headers.authorization = `Bearer ${token}`;
    const req = http.request(
      url,
      { method: "POST", headers, signal: AbortSignal.timeout(timeoutMs) },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => (text += chunk));
        res.on("end", () => {
          if ((res.statusCode ?? 500) >= 400) return reject(new Error(`HTTP ${res.statusCode}`));
          try {
            resolve(JSON.parse(text) as T);
          } catch (err) {
            reject(err as Error);
          }
        });
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.end(data);
  });
}

// Per session: the task title (for commit messages) and the files the agent's edit tools touched, which are the
// only files Lanes ever commits (security review: `git add -A` swept up secrets and the human's own work).
interface SessionState {
  title?: string;
  touched: string[];
  /** Files already changed when the prompt arrived: the human's, never published by Lanes. */
  dirtyAtStart?: string[];
  /** HEAD when the prompt arrived: what a whole-file Write is merged against (#218). */
  turnStart?: string;
  /** [path, HEAD after this session last edited it]: what the agent knows of that file; beats turnStart as the merge base (#218). */
  bases?: [string, string][];
  /** The server run (epoch) this session last talked to; a different one means it forgot every file version (#89). */
  epoch?: string;
  /** Integration commits already known to be in this checkout: a repeat edit of the same file skips the `git merge-base` (#132). */
  seen?: string[];
  /** Team context: files the agent read this turn, and files teammates' changes brought into the checkout this turn (M.2). */
  reads?: string[];
  arrived?: string[];
}

// `git config` launches cost 25-60 ms on Windows and were run on every hook: the identity is kept for a few minutes.
// shortcut: a changed user.name shows up in the views after at most IDENTITY_TTL_MS.
const IDENTITY_TTL_MS = 5 * 60_000;
const identities = new Map<string, { name?: string; email?: string }>();
function gitIdentity(root: string): { name?: string; email?: string } {
  const known = identities.get(root);
  if (known) return known;
  const file = path.join(privateDir("cache"), "identity.json");
  let cache: Record<string, { name?: string; email?: string; at: number }> = {};
  try {
    cache = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    // none yet
  }
  let entry = cache[root];
  if (!entry || Date.now() - entry.at > IDENTITY_TTL_MS) {
    entry = { at: Date.now() };
    for (const line of (tryGit(root, ["config", "--get-regexp", "^user\\.(name|email)$"]) ?? "").split("\n")) {
      const [key, ...value] = line.split(" ");
      if (key === "user.name") entry.name = value.join(" ").trim() || undefined;
      if (key === "user.email") entry.email = value.join(" ").trim() || undefined;
    }
    try {
      const tmp = `${file}.${process.pid}`;
      fs.writeFileSync(tmp, JSON.stringify({ ...cache, [root]: entry }), { mode: 0o600 });
      fs.renameSync(tmp, file);
    } catch {
      // an optimisation only
    }
  }
  identities.set(root, entry);
  return entry;
}
const stateFile = (sessionId: string) => path.join(privateDir("sessions"), `${sessionId.replace(/[^\w-]/g, "")}.json`);
export function loadState(sessionId: string): SessionState {
  let text: string;
  try {
    text = fs.readFileSync(stateFile(sessionId), "utf8");
  } catch {
    return { touched: [] }; // no state yet
  }
  try {
    return { touched: [], ...JSON.parse(text) };
  } catch {
    // Unreadable: keep it for inspection instead of silently starting over as if nothing was recorded (#83).
    try {
      fs.renameSync(stateFile(sessionId), stateFile(sessionId) + ".corrupt");
    } catch {
      // best effort
    }
    return { touched: [] };
  }
}
// Temp file + rename: a concurrent reader sees the old or the new file, never half of one (#83).
function saveState(sessionId: string, state: SessionState): void {
  const file = stateFile(sessionId);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
  // Windows refuses to rename over a file another process has open, and a parallel hook reads the state without the lock
  // (`post` reads the turn's bases): retry briefly instead of losing the update and the edit's publish (#255).
  for (let attempt = 0; ; attempt++) {
    try {
      return fs.renameSync(tmp, file);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (attempt >= 100 || !(code === "EPERM" || code === "EBUSY" || code === "EACCES")) {
        fs.rmSync(tmp, { force: true });
        throw err;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
}
/** At the end of a session its state goes, unless files are still waiting to be published (#114). */
async function forgetState(sessionId: string): Promise<void> {
  await withLock(`state-${sessionId}`, () => {
    if (loadState(sessionId).touched.length > 0) return;
    for (const f of [stateFile(sessionId), `${stateFile(sessionId)}.corrupt`]) fs.rmSync(f, { force: true });
  });
}

/** Old state files (and their .corrupt/.tmp leftovers) hold prompt titles for no reason: drop them after `maxAgeMs`. */
export function pruneSessions(maxAgeMs = 14 * 24 * 3_600_000): void {
  try {
    const dir = privateDir("sessions");
    for (const f of fs.readdirSync(dir)) {
      try {
        if (Date.now() - fs.statSync(path.join(dir, f)).mtimeMs > maxAgeMs) fs.rmSync(path.join(dir, f), { force: true });
      } catch {
        // gone already
      }
    }
  } catch {
    // best effort
  }
}

/** Read-modify-write of one session's state, serialised across the hook processes of that session (#83). */
export async function updateState(sessionId: string, change: (state: SessionState) => void): Promise<SessionState> {
  return withLock(`state-${sessionId}`, () => {
    const state = loadState(sessionId);
    change(state);
    saveState(sessionId, state);
    return state;
  });
}

/** Whose hook payload this is: the word after `--lanes` in the hook command. Claude Code and Codex share one format. */
export type Agent = "claude" | "gemini" | "cursor" | "antigravity" | "copilot" | "kiro";
const AGENT_NAMES: readonly string[] = ["gemini", "cursor", "antigravity", "copilot", "kiro"];
let agent: Agent = "claude";

/**
 * Another agent's payload in Claude's field names. Gemini CLI already uses them (`session_id`, `cwd`, `prompt`, `tool_name`,
 * `tool_input.file_path`: https://geminicli.com/docs/hooks/reference/). Cursor names its session `conversation_id` on every
 * event, and afterFileEdit carries one absolute `file_path` and no `cwd` (https://cursor.com/docs/hooks).
 * shortcut: Cursor's workspace_roots format on Windows is undocumented; it is only the fallback cwd, as the edited path is absolute.
 */
export function fromAgent(from: Agent, raw: Record<string, any>): HookInput {
  if (from === "antigravity") return fromAntigravity(raw);
  if (from === "copilot") return fromCopilot(raw);
  if (from === "kiro") return fromKiro(raw);
  if (from !== "cursor") return raw;
  const file = typeof raw.file_path === "string" ? raw.file_path : undefined;
  return {
    session_id: raw.conversation_id ?? raw.session_id,
    cwd: raw.cwd ?? raw.workspace_roots?.[0],
    prompt: raw.prompt,
    ...(file && { tool_name: "afterFileEdit", tool_input: { file_path: file } }),
  };
}

// Gemini CLI takes hookSpecificOutput.additionalContext on these events only (not BeforeTool).
const GEMINI_EVENTS: Record<string, string> = { SessionStart: "SessionStart", UserPromptSubmit: "BeforeAgent", PostToolUse: "AfterTool" };
/** The JSON that gives `text` to the agent at this (Claude-named) event, or undefined where that agent has no field for it. */
export function contextOutput(to: Agent, hookEventName: string, text: string): object | string | undefined {
  if (to === "antigravity") return antigravityContext(hookEventName, text);
  if (to === "copilot") return copilotContext(hookEventName, text);
  if (to === "kiro") return kiroContext(hookEventName, text); // plain text: Kiro adds exit-0 stdout to the context as is
  if (to === "cursor") return hookEventName === "SessionStart" ? { additional_context: text } : undefined; // beforeSubmitPrompt and afterFileEdit take no context
  if (to === "gemini") return GEMINI_EVENTS[hookEventName] ? { hookSpecificOutput: { hookEventName: GEMINI_EVENTS[hookEventName], additionalContext: text } } : undefined;
  return { hookSpecificOutput: { hookEventName, additionalContext: text } };
}
/**
 * What to print when there is nothing to say. Claude Code, Codex, Copilot and Kiro: nothing (Kiro would add any stdout to the context). Gemini parses stdout as JSON, so `{}`. Cursor:
 * `{}`, and an explicit `continue` on beforeSubmitPrompt (the docs do not say whether it may be left out). Never a decision.
 */
export function defaultOutput(to: Agent, event: string): object | undefined {
  if (to === "claude" || to === "antigravity" || to === "copilot" || to === "kiro") return undefined; // Antigravity: the hook command echoes the reply
  return to === "cursor" && event === "prompt" ? { continue: true } : {};
}

// Printed at once, so a note still reaches the agent if the hook is killed at its timeout. Only a Codex apply_patch of several
// files collects its notes and prints them once at the end, since stdout takes one JSON object.
let buffered = false;
let wrote = false;
let pending: { hookEventName: string; additionalContext: string } | undefined;
function write(json: object | string | undefined): void {
  if (!json) return;
  wrote = true;
  process.stdout.write(typeof json === "string" ? json : JSON.stringify(json));
}
function output(hookEventName: string, fields: { additionalContext: string }): void {
  if (!buffered) return write(contextOutput(agent, hookEventName, fields.additionalContext));
  pending = { hookEventName, additionalContext: pending ? `${pending.additionalContext} ${fields.additionalContext}` : fields.additionalContext };
}
function flush(event: string): void {
  if (pending) write(contextOutput(agent, pending.hookEventName, pending.additionalContext));
  if (!wrote) write(defaultOutput(agent, event));
}

/** Files one edit tool call touches: Claude's file_path or notebook_path, or each file of a Codex apply_patch, sorted. */
export function editedFiles(input: HookInput): string[] {
  const one = input.tool_input?.file_path ?? input.tool_input?.notebook_path;
  if (one) return [one];
  const patch = input.tool_input?.command;
  if (input.tool_name !== "apply_patch" || typeof patch !== "string") return [];
  // shortcut: Codex's docs only say the patch is in tool_input.command; these header lines are its apply_patch grammar
  // (codex-rs/apply-patch). Re-check if Codex changes the patch format.
  const files = [...patch.matchAll(/^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gm)].map((m) => m[1].trim());
  // Sorted: two patches that share files acquire them in the same order and never wait on each other.
  return [...new Set(files)].sort();
}

/**
 * The lines an edit is about to change in `text` (S6.1): the span of each old_string (Edit, MultiEdit's edits, Gemini's
 * replace), as one range. Undefined when unknown: a whole-file write, an empty, missing or repeated old_string.
 */
export function editSpan(text: string, toolInput: HookInput["tool_input"]): LineRange | undefined {
  const olds = Array.isArray(toolInput?.edits) ? toolInput.edits.map((e) => e?.old_string) : [toolInput?.old_string];
  const body = text.replace(/\r\n/g, "\n"); // Claude sends old_string with \n line ends whatever the file has
  let span: LineRange | undefined;
  for (const raw of olds) {
    if (typeof raw !== "string" || raw === "") return undefined;
    const old = raw.replace(/\r\n/g, "\n");
    const at = body.indexOf(old);
    if (at < 0 || body.indexOf(old, at + 1) >= 0) return undefined;
    const first = body.slice(0, at).split("\n").length;
    const last = first + old.replace(/\n$/, "").split("\n").length - 1;
    span = span ? [Math.min(span[0], first), Math.max(span[1], last)] : [first, last];
  }
  return span;
}

// predictFiles runs while the user waits (15 s hook timeout): bound the work and keep it linear (#85). The old
// backtracking regex took 7 s on a 100 KB token and one RegExp per repository file.
const MAX_PROMPT_SCAN = 20_000;
const MAX_TOKEN = 260;
const GENERIC_STEMS = new Set(["index", "types", "main", "readme", "package"]);
const isWordChar = (c: string | undefined) => c !== undefined && /\w/.test(c);

/** True if `word` occurs in `text` between non-word characters. */
function hasWord(text: string, word: string): boolean {
  for (let i = text.indexOf(word); i >= 0; i = text.indexOf(word, i + 1)) {
    if (!isWordChar(text[i - 1]) && !isWordChar(text[i + word.length])) return true;
  }
  return false;
}

const quoteList = (ps: string[]) => (ps.length > 8 ? `${ps.slice(0, 8).join(", ")} and ${ps.length - 8} more` : ps.join(", "));

/**
 * Turn end, team context (M.2): files a teammate changed this turn that this turn's code depends on (read, or imported by
 * an edited file), and new teammate files that import a file this turn edited. Files this turn edited itself are left to
 * the re-apply path.
 */
export function staleDependencies(root: string, edited: string[], reads: string[], arrived: string[]): { text: string; paths: string[] } | undefined {
  const mine = new Set(edited);
  const came = arrived.filter((p) => !mine.has(p));
  if (came.length === 0) return undefined;
  const deps = new Set([...reads, ...edited.flatMap((f) => importsOf(root, f))]);
  const used = came.filter((p) => deps.has(p));
  const callers = came.filter((p) => !deps.has(p) && importsOf(root, p).some((i) => mine.has(i)));
  if (used.length === 0 && callers.length === 0) return undefined;
  const text: string[] = [];
  if (used.length > 0)
    text.push(`While you worked, a teammate's agent changed ${quoteList(used)}, which your code uses. Re-read it and make sure your changes match the new version before finishing.`);
  if (callers.length > 0)
    text.push(`A teammate's agent added or changed ${quoteList(callers)}, which imports a file you changed. Check it still matches your change.`);
  text.push("No need to ask the user.");
  return { text: text.join(" "), paths: [...used, ...callers] };
}

/** Files a prompt is likely to touch: explicit paths, plus module names that match repository files. */
export function predictFiles(root: string, prompt: string): string[] {
  const text = prompt.slice(0, MAX_PROMPT_SCAN);
  const files = listFiles(root);
  const predicted = new Set<string>();
  // Explicit paths: tokens ending in a short extension, matched against every path suffix of every file.
  const tokens = new Set<string>();
  for (const raw of text.split(/[^\w./-]+/)) {
    const token = raw.replace(/\.+$/, "").replace(/^\.\//, "");
    if (token.length <= MAX_TOKEN && /\.[a-z]{1,4}$/i.test(token)) tokens.add(token.toLowerCase());
  }
  if (tokens.size > 0) {
    for (const f of files) {
      for (let at = -1; ; at = f.indexOf("/", at + 1)) {
        if (tokens.has(f.slice(at + 1).toLowerCase())) predicted.add(f);
        if (f.indexOf("/", at + 1) < 0) break;
      }
    }
  }
  const lower = text.toLowerCase();
  const stems = new Map<string, boolean>();
  for (const f of files) {
    const stem = path.posix.basename(f).replace(/\.[^.]+$/, "").toLowerCase();
    if (stem.length < 4 || GENERIC_STEMS.has(stem)) continue;
    if (!stems.has(stem)) stems.set(stem, hasWord(lower, stem));
    if (stems.get(stem)) predicted.add(f);
  }
  return [...predicted].slice(0, 20);
}

async function run(event: HookEvent, input: HookInput, config: Config): Promise<void> {
  const sessionId = input.session_id;
  if (!sessionId) return;
  const cwd = input.cwd ?? process.cwd();
  const userFor = (dir: string) => config.user ?? gitIdentity(dir).name ?? os.userInfo().username;
  // No absolute paths leave the machine (security review): the label is the folder name only.
  const ref = (repo: RepoInfo) => ({ user: userFor(repo.root), sessionId, repo: repo.id, label: repo.label });
  const observe = (repo: RepoInfo | null, fields: Record<string, unknown>) => {
    // git error text can carry remote URLs with credentials (security review).
    if (typeof fields.error === "string") fields.error = redactSecrets(fields.error);
    return post(config, "/v1/observe", { sessionId, user: repo ? userFor(repo.root) : config.user, repo: repo?.id, ...fields }, 2_000).catch(() => {});
  };

  if (event === "observe") {
    await observe(findRepo(cwd), { command: input.tool_input?.command });
    return;
  }

  // Team context only: a heads-up when the agent reads a file a teammate is changing, before it writes code against the old
  // version (M.2: the I1/I3 benchmark). No lease, no decision; silent when off or when the server is down.
  if (event === "read") {
    const file = input.tool_input?.file_path;
    const loc = file ? locate(path.resolve(cwd, file)) : null;
    if (!loc || !teamContextOn(loc.repo.root)) return;
    await updateState(sessionId, (s) => void (s.reads = [...(s.reads ?? []).filter((p) => p !== loc.path), loc.path].slice(-200)));
    const heads = await post<{ text: string }>(config, "/v1/team/context", { ...ref(loc.repo), path: loc.path, read: true }, 1_500).catch(() => undefined);
    if (heads?.text) output("PreToolUse", { additionalContext: heads.text });
    return;
  }

  if (event === "end") await forgetState(sessionId);
  if (event === "start" || event === "end") pruneSessions();

  if (event === "prompt") {
    const repo = findRepo(cwd);
    if (!repo) return;
    const promptText = input.prompt ?? "";
    const firstLine = promptText.split("\n").find((l) => l.trim())?.trim() ?? "";
    // shortcut: titles are on by default (ADR-0018); LANES_NO_PROMPT_TEXT=1 keeps prompt text out of commits and the
    // server entirely. Free text can't be redacted reliably, so make it a per-user setting before wider rollout.
    const title = process.env.LANES_NO_PROMPT_TEXT === "1" ? "Agent task" : redactSecrets(firstLine).slice(0, 120) || "Agent task";
    // Saved before the server call, so commits are named even when the server is down.
    // Unreadable status: no baseline, so nothing is ever mistaken for "created during the turn" (#84).
    let dirtyAtStart: string[] | undefined;
    try {
      dirtyAtStart = changedPaths(repo.root);
    } catch {
      // observed at the end of the turn
    }
    // Cursor reports an edit only after writing it (no pre hook): its whole turn counts as an edit in flight (#261).
    if (agent === "cursor") await withLock(checkoutLock(repo.root), () => markEditInFlight(repo.root, sessionId, CURSOR_TURN, true), LOCK_WAIT_MS).catch(() => {});
    const turnStart = tryGit(repo.root, ["rev-parse", "HEAD"]) ?? undefined;
    await updateState(sessionId, (s) => Object.assign(s, { title, dirtyAtStart, turnStart, bases: [], reads: [], arrived: [] }));
    // Overlaps are tracked on the server for the team views; the agent isn't told (ADR-0016: stay out of the way)
    // unless the repository opted into team context (ADR-0028).
    await post<{ task: Task }>(config, "/v1/task", { ...ref(repo), title, predicted: predictFiles(repo.root, promptText) }, 5_000);
    if (teamContextOn(repo.root)) {
      const brief = await post<{ text: string; deliver?: string[] }>(config, "/v1/team/context", ref(repo), 2_000).catch(() => undefined);
      if (brief?.text) output("UserPromptSubmit", { additionalContext: brief.text });
      // Printed first: approved requests count as delivered only once the agent has them (review #10). Cursor takes no
      // context here (nothing written), so its requests wait for an agent that does.
      if (wrote && brief?.deliver?.length) await post(config, "/v1/team/ack", { ...ref(repo), ids: brief.deliver }, 1_000).catch(() => {});
    }
    return;
  }

  const identity = (repo: RepoInfo): Identity => {
    const name = userFor(repo.root);
    return { name, email: config.email ?? gitIdentity(repo.root).email ?? `${name}@users.noreply.lanes.dev` };
  };

  /** Signed checkpoint + publish to the integration branch, then release leases (per edit, and at turn end). */
  const publish = async (repo: RepoInfo, final: boolean, edited?: string, extraNotes: string[] = []) => {
    const state = await updateState(sessionId, (s) => {
      if (edited && !s.touched.includes(edited)) s.touched.push(edited);
    });
    // Per edit: just that file. At the end of the turn: everything the edit tools touched, in case a publish failed.
    // At the end of a turn, also files the turn created or changed outside the edit tools (spike v3d: a generated
    // file imported by a published edit left the shared branch broken).
    let fromTurn: string[] = [];
    if (!edited && state.dirtyAtStart) {
      try {
        fromTurn = filesFromTurn(repo.root, state.dirtyAtStart);
      } catch (err) {
        await observe(repo, { kind: "status-failed", error: (err as Error).message });
      }
    }
    const paths = edited ? [edited] : [...new Set([...state.touched, ...fromTurn])];
    // One publish at a time per checkout: parallel git add/commit/rebase fight over index.lock, and a publish that
    // loses that fight leaves files staged but never committed (#83).
    const team = teamContextOn(repo.root);
    const limits = final
      ? { commitDeadlineMs: COMMIT_DEADLINE_MS ?? 30_000, budgetMs: 70_000, sync: team }
      : { commitDeadlineMs: COMMIT_DEADLINE_MS ?? 12_000, budgetMs: 30_000 };
    // The wait for the lock counts against the same budget as the publish, so the lease release below is always sent
    // inside the hook's own timeout (#110).
    const waitStart = Date.now();
    const result = await withLock(
      checkoutLock(repo.root),
      () => checkpointAndPublish(repo.root, identity(repo), { session: sessionId, task: state.title ?? "Agent changes" }, paths, { ...limits, budgetMs: Math.max(limits.budgetMs - (Date.now() - waitStart), 0) }),
      LOCK_WAIT_MS,
    );
    // Files git could not stage are neither forgotten nor reported as done: they stay in `touched` for the next publish (#109).
    const failed = result.failed ?? [];
    if (final && (result.status === "published" || result.status === "nothing")) {
      await updateState(sessionId, (s) => void (s.touched = [...s.touched.filter((p) => !paths.includes(p)), ...failed]));
    }
    if (result.status !== "published" && result.status !== "nothing") {
      await observe(repo, { kind: `publish-${result.status}`, error: "error" in result ? result.error : undefined });
    }
    if (failed.length > 0) await observe(repo, { kind: "publish-add-failed", paths: failed });
    if (result.status === "published" && result.blocked) await observe(repo, { kind: "publish-blocked", paths: result.blocked });
    if (result.status === "published" && result.syncSkipped) await observe(repo, { kind: "sync-skipped", error: result.syncSkipped });
    const published = result.status === "published";
    // Agent-only and neutral, like every agent-facing text (spike v3). Printed before the server call, so it still
    // reaches the agent when the server is down, which is when overlapping edits happen.
    const notes: string[] = [...extraNotes];
    const reapply = published && result.reapply && result.reapply.paths.length > 0 ? result.reapply : undefined;
    if (reapply) {
      const short = reapply.backup.slice(0, 12);
      notes.push(
        `${reapply.paths.join(", ")} received newer content that overlaps your latest edit, so that edit is not in the file now. ` +
          `This is expected. Your version is saved in commit ${short} (git show ${short}). ` +
          "Re-read the file and apply your change again on top of the new content.",
      );
      await observe(repo, { kind: "reapply", paths: reapply.paths, backup: reapply.backup });
    }
    // What the agent read earlier may now be out of date (spike v3d, L5: a long agent wrote tests against modules
    // that teammates had since renamed). Only during a turn; the file just edited is already current.
    const pulled = ("pulled" in result ? (result.pulled ?? []) : []).filter((p) => p !== edited && !reapply?.paths.includes(p));
    if (!final && pulled.length > 0) {
      const list = quoteList(pulled);
      notes.push(
        `Newer content arrived for ${list} while you worked. If what you are doing depends on these files, re-read them ` +
          "and make your code match the new version. This is expected; no need to ask the user.",
      );
      await observe(repo, { kind: "pulled", paths: pulled });
    }
    if (team && pulled.length > 0) await updateState(sessionId, (s) => void (s.arrived = [...new Set([...(s.arrived ?? []), ...pulled])].slice(-500)));
    const stale = team && final ? staleDependencies(repo.root, paths, state.reads ?? [], [...new Set([...(state.arrived ?? []), ...pulled])]) : undefined;
    if (stale) {
      notes.push(stale.text);
      await observe(repo, { kind: "stale-dependency", paths: stale.paths });
    }
    if (notes.length > 0 && !final) output("PostToolUse", { additionalContext: notes.join(" ") });
    // At the end of a turn, continue instead of stopping to re-apply or re-check a dependency, once (stop_hook_active guards
    // against a loop). shortcut: Claude Code and Codex only. Gemini (AfterAgent deny) and Cursor (stop followup_message) could do
    // the same; until then the backup commit and the team views' events are all that remain.
    else if ((reapply || stale) && final && !input.stop_hook_active && agent === "claude") write({ decision: "block", reason: notes.join(" ") });
    // Line ranges only where a teammate's heads-up can use them; the server takes them for up to 50 files.
    const ranges = published && result.base && teamContextOn(repo.root) ? changedRanges(repo.root, result.base, result.commit, result.paths.slice(0, 50)) : undefined;
    await post(config, "/v1/publish", { ...ref(repo), commit: published ? result.commit : undefined, paths: published ? result.paths.slice(0, MAX_REPORTED_PATHS) : [], release: edited ? [edited] : undefined, final, ranges }, 5_000);
  };

  const acquireDeadline = Date.now() + ACQUIRE_WAIT_MS;
  const editOne = async (file: string): Promise<void> => {
    const abs = path.resolve(cwd, file);
    const loc = locate(abs);
    if (!loc) return; // Not in a git repository: nothing to coordinate.
    if (event === "post") {
      markEditInFlight(loc.repo.root, sessionId, loc.path, false); // written: our own git operations may run
      const extra: string[] = [];
      const known = loadState(sessionId);
      // The agent's own earlier edits of this file are in HEAD already: merging against the prompt-time HEAD would bring a line
      // it deliberately removed back. The base is what it last saw of this file.
      // Whole-file writes: Claude's Write, Gemini's write_file, Factory's Create. Cursor reports every edit as one kind, so none is treated as whole.
      const turnStart = ["Write", "write_file", "Create"].includes(input.tool_name ?? "") ?(known.bases?.find(([p]) => p === loc.path)?.[1] ?? known.turnStart) : undefined;
      if (turnStart) {
        const merged = await withLock(checkoutLock(loc.repo.root), () => mergeStaleWrite(loc.repo.root, loc.path, turnStart), LOCK_WAIT_MS);
        if (merged === "merged") {
          extra.push(`${loc.path} was replaced as a whole from an older copy: lines teammates added meanwhile were put back into it. This is expected. Re-read the file if your next step depends on it.`);
          await observe(loc.repo, { kind: "write-merged", path: loc.path });
        } else if (merged === "conflict") await observe(loc.repo, { kind: "write-conflict", path: loc.path });
      }
      await publish(loc.repo, false, loc.path, extra);
      if (agent === "cursor") markEditInFlight(loc.repo.root, sessionId, CURSOR_TURN, true); // a long turn stays marked
      const head = tryGit(loc.repo.root, ["rev-parse", "HEAD"]);
      if (head) await updateState(sessionId, (s) => void (s.bases = [...(s.bases ?? []).filter(([p]) => p !== loc.path), [loc.path, head] as [string, string]].slice(-200)));
      return;
    }
    if (event === "permission") {
      markEditInFlight(loc.repo.root, sessionId, loc.path, true); // still in flight while the user decides (refreshes its age)
      // No decision: the user's approval prompt is shown as usual; we only keep the lease alive meanwhile.
      await post(config, "/v1/hold", { ...ref(loc.repo), tool: input.tool_name ?? "unknown", paths: [loc.path], holdMs: APPROVAL_HOLD_MS }, 2_000);
      return;
    }
    // One wait budget for the whole tool call: a multi-file apply_patch must not wait 240 s per file against one hook timeout.
    const body = { ...ref(loc.repo), tool: input.tool_name ?? "unknown", paths: [loc.path], hookMs: +performance.now().toFixed(1), waitMs: Math.max(acquireDeadline - Date.now(), 0) };
    const started = Date.now();
    let res: AcquireResponse;
    try {
      res = await post<AcquireResponse>(config, "/v1/acquire", body, ACQUIRE_WAIT_MS + 10_000);
    } catch (err) {
      // The edit goes ahead uncoordinated (fail open): count it in the local ledger, no path or name (pricing-validation.md).
      appendLedger(loc.repo.id, "failopen", Date.now() - started);
      throw err;
    }
    // Never refuse an edit (founder, spike v3): a refusal can make the agent stop and the user re-prompt.
    // A wait this long means something is broken; go ahead and let the team views flag it.
    if (res.decision === "timeout") {
      appendLedger(loc.repo.id, "failopen", res.waitedMs);
      await observe(loc.repo, { kind: "wait-overrun", path: loc.path, waitedMs: res.waitedMs });
      return;
    }
    appendLedger(loc.repo.id, res.waitedMs > 0 ? "queued" : "ok", res.waitedMs);
    // Heads-up about teammates' work on this file (ADR-0028): context only, never a permission decision.
    const notes: string[] = [];
    if (teamContextOn(loc.repo.root)) {
      let range: LineRange | undefined;
      try {
        range = editSpan(fs.readFileSync(abs, "utf8"), input.tool_input);
      } catch {
        // a new or unreadable file: the heads-up stays file-level
      }
      const heads = await post<{ text: string }>(config, "/v1/team/context", { ...ref(loc.repo), path: loc.path, range }, 2_000).catch(() => undefined);
      if (heads?.text) notes.push(heads.text);
    }
    const say = () => notes.length > 0 && output("PreToolUse", { additionalContext: notes.join(" ") });
    // The server is back: tell it about edits that went ahead without it (a count, nothing else).
    const missed = takeUnreported(loc.repo.id);
    if (missed > 0) await observe(loc.repo, { kind: "uncoordinated", count: missed });
    const version = res.versions[loc.path];
    // A restarted server has no versions, so it cannot say what changed: check the integration tip once per run (#89).
    const known = loadState(sessionId);
    const restarted = res.epoch !== known.epoch;
    if (restarted) await updateState(sessionId, (s) => void (s.epoch = res.epoch));
    // The commit id comes from the server and goes to git: only a real object id is accepted (security review).
    let behind = restarted;
    if (version) {
      behind = false;
      if (COMMIT_ID.test(version.commit) && !known.seen?.includes(version.commit)) {
        behind = !isAncestor(loc.repo.root, version.commit) && !isOwnPublished(loc.repo.root, version.commit);
        if (!behind) await updateState(sessionId, (s) => void (s.seen = [...(s.seen ?? []).slice(-99), version.commit]));
      }
    }
    if (behind) {
      const before = fileHash(abs);
      const synced = await withLock(checkoutLock(loc.repo.root), () => syncFromIntegration(loc.repo.root, identity(loc.repo), sessionId), LOCK_WAIT_MS);
      if (!synced.ok) {
        // Not refused either: the edit is committed locally and can't be lost; the views flag it.
        if (!synced.skipped) await observe(loc.repo, { kind: "sync-failed", path: loc.path, error: synced.error }); // skipped: another agent is mid-edit in this checkout, momentary
        say();
        return;
      }
      const changed = fileHash(abs) !== before;
      await observe(loc.repo, { kind: "synced", path: loc.path, from: version?.user, changed });
      // Neutral wording: naming a teammate made agents report it, and one asked its user to confirm (spike v3 round 1).
      // Claude Code's "modified since read" check only covers its own Read tool (spike v2, carl-3), so say it here.
      // Agent-only context; no permission decision, so the user's normal permission flow still applies.
      if (changed) {
        notes.unshift(`${loc.path} has new content since you last read it. This is expected: edits to this file are coordinated automatically, so the new content should stay and needs no checking from you or the user. Re-read it with the Read tool, then make your edit.`);
      }
    }
    say();
    return; // Allowed: no permission decision, so the user's normal permission flow applies.
  };
  if (event === "pre" || event === "permission" || event === "post") {
    // A failure on one file (server down) still lets the others be published; the first error is reported after.
    let failed: Error | undefined;
    const files = editedFiles(input);
    buffered = files.length > 1;
    // shortcut: a multi-file apply_patch publishes file by file, each with its own budget, against one 40 s PostToolUse timeout;
    // files left when it is killed are published at Stop. Publish them in one call if Codex use shows it matters.
    for (const file of files) await editOne(file).catch((err: Error) => void (failed ??= err));
    // The agent writes the files once this hook returns: mark them so no other session's git operation rewrites the
    // working tree meanwhile (#261). Under the checkout lock, so a sync or publish already running finishes first. Post clears it.
    if (event === "pre") {
      for (const file of files) {
        const loc = locate(path.resolve(cwd, file));
        if (loc) await withLock(checkoutLock(loc.repo.root), () => markEditInFlight(loc.repo.root, sessionId, loc.path, true), LOCK_WAIT_MS).catch(() => {});
      }
    }
    if (failed) throw failed;
    return;
  }

  const repo = findRepo(cwd);
  if (!repo) return;
  // A tool call refused by its user or the agent after its pre hook never gets a post: the turn's end clears what it marked.
  if (event === "stop" || event === "end") markEditInFlight(repo.root, sessionId, undefined, false);
  if (event === "stop") {
    await publish(repo, true);
    return;
  }
  if (event === "start") {
    // Agent-only, neutral (spike v3 risk 1): without it, 3 of 8 agents told their user that "something other
    // than me" had committed their own edits. Printed first so it still applies when the server is down.
    output("SessionStart", {
      additionalContext:
        "In this repository, each file edit you make is saved automatically as a commit on your branch, named after the " +
        "current request. You don't need to commit. Those commits are your own edits; this is expected.",
    });
  }
  // Registered before the sync, so a slow or unreachable remote can never keep the session from being known (#131).
  let registerError: Error | undefined;
  await post(config, "/v1/session", { ...ref(repo), event }, 2_000).catch((err: Error) => void (registerError = err));
  if (event === "start") {
    // SessionStart is killed at 5 s: its fetch gets a short timeout, unlike the publish path (#131, #141).
    process.env.LANES_NET_TIMEOUT_MS ??= "2000";
    const synced = await withLock(checkoutLock(repo.root), () => syncFromIntegration(repo.root, identity(repo), sessionId), 2_000);
    if (!synced.ok && !synced.skipped) await observe(repo, { kind: "sync-failed", path: "(session start)", error: synced.error });
  }
  if (registerError) throw registerError;
}

// Runs only when invoked as a hook, so tests can import predictFiles.
if (import.meta.main) {
  const event = process.argv[2] ?? "";
  // A headless run of a teammate's approved request (lanes approve --run) stays in its own worktree: no leases, no task,
  // and above all no publish to the shared branch before its receiver has reviewed it.
  if (process.env.LANES_OFF === "1") process.exit(0);
  if (!EVENTS.includes(event)) {
    process.stderr.write(`lanes hook: unknown event "${event}"\n`);
    process.exit(0);
  }
  agent = AGENT_NAMES.includes(process.argv[4]) ? (process.argv[4] as Agent) : "claude";
  // The Copilot cloud agent runs .github/hooks on a GitHub runner: not a teammate's checkout, nothing to coordinate.
  if (agent === "copilot" && isCopilotCloud(process.env)) process.exit(0);
  let raw: Record<string, any> = {};
  try {
    raw = JSON.parse(fs.readFileSync(0, "utf8") || "{}");
  } catch {
    // Malformed input: treat as empty, which makes every event a no-op.
  }
  // Cursor also runs the hooks in .claude/settings.json (on by default: https://cursor.com/docs/reference/third-party-hooks), with
  // Cursor's tool names (an Edit arrives as Write). Those stay inert there: `lanes init --agents cursor` installs the Cursor hooks,
  // and coordinating each edit twice would publish it twice. Cursor's stdin always carries cursor_version; the env var is not used,
  // because Claude Code started from Cursor's terminal may inherit it and must keep working.
  if (agent === "claude" && raw.cursor_version) process.exit(0);
  // Copilot runs .claude/settings.json too: inert there as well; `lanes init --agents copilot` installs its own hooks (S3.5).
  if (agent === "claude" && isCopilotClaudeFormat(raw)) process.exit(0);
  const input = fromAgent(agent, raw);
  const config = loadConfig();
  run(event as HookEvent, input, config).then(
    () => {
      flush(event);
      process.exit(0);
    },
    // Fail open (ADR-0019): never refuse an edit. Exit 0 keeps stderr out of the agent's context; the views show "offline".
    (err: Error) => {
      flush(event);
      process.stderr.write(`lanes hook: coordination paused, server ${config.serverUrl} unreachable (${err.message})\n`);
      process.exit(0);
    },
  );
}
