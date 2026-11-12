// Scripted multi-agent runner for spike v2/v3. Usage:
//   node runner/run.ts V1 [V2 ...] [--runs N] [--dry] [--remote]
// Each run: fresh copy of the test repo with an integration branch (lanes/main), one worktree per agent
// (--remote: lanes/main on a bare origin and one separate clone per agent, as if on different machines),
// a Lanes server in this process, and one `claude -p` (Haiku) per agent launched together.
// After the run it verifies every task on lanes/main and records errors. See docs/plans/phase-2b-spike-v2.md.
import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Coordinator } from "../../packages/server/src/coordinator.ts";
import { startServer, type RunningServer } from "../../packages/server/src/server.ts";
import { withLanesHooks } from "../../packages/core/src/settings.ts";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const ROOT = path.join(HERE, "..", "..");
// Scenario data (testbed/template, scenarios.json) is read from the frozen spike; nothing under spike/ is written.
const TESTBED = path.join(ROOT, "spike", "testbed");
const OUT = process.env.LANES_RUNNER_OUT ?? path.join(HERE, "results");
const TEMPLATE = path.join(TESTBED, "template");
const RESULTS = path.join(OUT, "runs");
// Runs the bundled hook of the packages, as the MVP ships it: `npm run build` first.
const HOOK = path.join(ROOT, "dist", "hook.cjs");
const REMOTE = process.argv.includes("--remote");
// Arm D of the multiplayer benchmark (docs/benchmark/method.md): team context on, committed like `lanes team on`.
const TEAM = process.argv.includes("--team");
// The arm label in results: C (leases only) or D (team context) by default; `--arm D2` names a later build of team context.
const armAt = process.argv.indexOf("--arm");
const ARM = (armAt >= 0 && process.argv[armAt + 1]) || (TEAM ? "D" : "C");
const RUN_TOKEN = crypto.randomBytes(16).toString("hex");
const RUN_HOME = path.join(os.tmpdir(), "lanes-runner-home");
const LEDGER = path.join(OUT, "ledger.json");
const CLAUDE = process.env.CLAUDE_BIN ?? "claude";
const INTEGRATION = "lanes/main";

const TOTAL_CAP_USD = Number(process.env.LANES_CAP_USD ?? 40); // API-equivalent; the runs use a subscription
const SESSION_CAP_USD = 0.5;
const AGENT_TIMEOUT_MS = 10 * 60_000; // hard tasks with Sonnet take longer (spike v3c)

interface Check { file: string; pattern: string }
// `run`: JavaScript executed in a checkout of the final lanes/main (it may import ./src/index.ts); it must not throw.
// Behaviour, not just text: catches semantic conflicts, e.g. a call to a function another agent renamed.
// `followUps`: further prompts sent in the same session (`--resume`) after each turn ends: a long, multi-turn session.
// `suffix` replaces the scenario-wide prompt suffix ("don't run tests"), for tasks that must run tests (spike v3d, L5).
// `checkAt: "own-last"`: run the behaviour check on lanes/main as of the agent's own last commit (was its work right
// given what had landed while it worked?); whether later changes broke it is recorded separately (spike v3d, L5).
interface TaskSpec { prompt: string; checks: Check[]; run?: string; followUps?: string[]; suffix?: string; checkAt?: "own-last" }
// `delaySec`: start later, so teammates' work keeps landing during a long task. `sessionCapUsd` overrides the scenario's.
interface AgentSpec { user: string; task: string; model?: string; delaySec?: number; sessionCapUsd?: number }
interface Scenario {
  description: string;
  runs: number;
  agents: AgentSpec[];
  ttlMs?: number;
  killHolderFirst?: boolean;
  promptAppend?: string;
  /** Point every agent at a server that isn't there: no coordination at all, only publish and re-apply. */
  serverDown?: boolean;
  /** Untracked files placed in every checkout before the agents start (e.g. a .env); they must never be published. */
  plant?: Record<string, string>;
  /** Strings that must appear nowhere: not on lanes/main (files or messages), not in the server log. */
  secrets?: string[];
  /** Shell commands the agents may run without asking, e.g. ["Bash(node:*)"] for generators and tests. */
  allowedTools?: string[];
  /** Long tasks: per-session spend cap (API-equivalent) and time limit. */
  sessionCapUsd?: number;
  timeoutMin?: number;
}
interface Config { promptSuffix: string; tasks: Record<string, TaskSpec>; scenarios: Record<string, Scenario> }

interface Agent extends AgentSpec {
  name: string;
  cwd: string;
  promptAppend?: string;
  allowedTools?: string[];
  sessionCapUsd?: number;
  timeoutMs?: number;
}

interface ToolError { tool: string; text: string }

interface AgentResult {
  name: string;
  user: string;
  task: string;
  sessionIds: string[];
  exitCode: number | null;
  killed: boolean;
  costUsd: number;
  durationMs: number;
  turns: number;
  finalText: string;
  toolErrors: ToolError[];
  taskDone: boolean;
  failedChecks: Check[];
  unpublished: string[];
  reapplies: number;
  laterChanges?: string;
  model: string;
  /** Assistant text that asks the user to decide or confirm (the spike v3 failure); the benchmark's disruption metric. */
  asksUser: number;
}

// Fixed before any run (docs/benchmark/method.md); changing it means re-running every arm.
const ASKS_USER = /\b(should I|shall I|do you want me to|would you like me to|please confirm|let me know if|before I proceed)\b/i;

const config: Config = JSON.parse(fs.readFileSync(path.join(TESTBED, "scenarios.json"), "utf8"));
// Benchmark scenarios added after the spike froze (I1–I3: intent conflicts leases alone can't see), same template.
const extra = JSON.parse(fs.readFileSync(path.join(ROOT, "docs", "benchmark", "scenarios.json"), "utf8"));
Object.assign(config.tasks, extra.tasks);
Object.assign(config.scenarios, extra.scenarios);

// ---------- cost ledger ----------

function spent(): number {
  try {
    return JSON.parse(fs.readFileSync(LEDGER, "utf8")).totalUsd as number;
  } catch {
    return 0;
  }
}

function addSpend(usd: number, label: string): void {
  const ledger = fs.existsSync(LEDGER) ? JSON.parse(fs.readFileSync(LEDGER, "utf8")) : { totalUsd: 0, entries: [] };
  ledger.totalUsd = +(ledger.totalUsd + usd).toFixed(4);
  ledger.entries.push({ at: new Date().toISOString(), label, usd });
  fs.writeFileSync(LEDGER, JSON.stringify(ledger, null, 2));
}

function assertBudget(worstCase: number, sessions: number): void {
  if (spent() + worstCase > TOTAL_CAP_USD) {
    throw new Error(`Budget guard: $${spent().toFixed(2)} spent; ${sessions} more sessions could exceed the $${TOTAL_CAP_USD} cap.`);
  }
}

// ---------- git ----------

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=Lanes Spike", "-c", "user.email=spike@lanes.dev", ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function tryGit(cwd: string, ...args: string[]): string | null {
  try {
    return git(cwd, ...args);
  } catch {
    return null;
  }
}

function setUpRepo(work: string, specs: AgentSpec[]): { main: string; agents: Agent[] } {
  const main = path.join(work, "acme-shop");
  fs.cpSync(TEMPLATE, main, { recursive: true });
  fs.mkdirSync(path.join(main, ".claude"), { recursive: true });
  fs.writeFileSync(path.join(main, ".claude", "settings.json"), JSON.stringify(withLanesHooks({}, process.execPath, HOOK, true), null, 2));
  if (TEAM) {
    fs.mkdirSync(path.join(main, ".lanes"), { recursive: true });
    fs.writeFileSync(path.join(main, ".lanes", "team.json"), JSON.stringify({ context: true }));
  }
  git(main, "init", "-q", "-b", "main");
  git(main, "add", "-A");
  git(main, "commit", "-q", "-m", "initial");
  git(main, "branch", INTEGRATION);
  if (REMOTE) {
    // Results are then read from the bare origin, which plays the shared remote.
    const origin = path.join(work, "origin.git");
    git(work, "clone", "-q", "--bare", main, origin);
    const agents = specs.map((spec, i): Agent => {
      const name = `${spec.user}-${i + 1}`;
      const cwd = path.join(work, `clone-${name}`);
      git(work, "clone", "-q", "-b", INTEGRATION, origin, cwd);
      git(cwd, "checkout", "-q", "-b", `agent/${name}`);
      return { ...spec, name, cwd };
    });
    return { main: origin, agents };
  }
  const agents = specs.map((spec, i): Agent => {
    const name = `${spec.user}-${i + 1}`;
    const cwd = path.join(work, `wt-${name}`);
    git(main, "worktree", "add", "-q", cwd, "-b", `agent/${name}`, INTEGRATION);
    return { ...spec, name, cwd };
  });
  return { main, agents };
}

// ---------- agents ----------

function childEnv(serverUrl: string, user: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    // Don't let the child think it's nested inside this session.
    if (!/^CLAUDE_?CODE/i.test(key)) env[key] = value;
  }
  // Token-protected like a real server; hooks keep their state out of the real ~/.lanes, and never auto-start one.
  const lanes = { LANES_SERVER: serverUrl, LANES_TOKEN: RUN_TOKEN, LANES_HOME: RUN_HOME, LANES_AUTOSTART: "0" };
  return { ...env, ...lanes, LANES_USER: user, LANES_EMAIL: `${user}@acme.dev`, ...(REMOTE ? { LANES_REMOTE: "origin" } : {}) };
}

function parseStream(file: string) {
  const messages = (fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "")
    .split("\n")
    .filter(Boolean)
    .flatMap((l) => {
      try {
        return [JSON.parse(l)];
      } catch {
        return [];
      }
    });
  const toolNames = new Map<string, string>();
  const toolErrors: ToolError[] = [];
  for (const m of messages) {
    for (const block of m.message?.content ?? []) {
      if (block.type === "tool_use") toolNames.set(block.id, block.name);
      if (block.type === "tool_result" && block.is_error) {
        const text = Array.isArray(block.content) ? block.content.map((c: { text?: string }) => c.text ?? "").join(" ") : String(block.content ?? "");
        toolErrors.push({ tool: toolNames.get(block.tool_use_id) ?? "?", text: text.slice(0, 400) });
      }
    }
  }
  const asksUser = messages.filter((m) => m.type === "assistant" && (m.message?.content ?? []).some((b: { type: string; text?: string }) => b.type === "text" && ASKS_USER.test(b.text ?? ""))).length;
  return { messages, toolErrors, asksUser, result: messages.findLast((m) => m.type === "result") };
}

/** Kills the agent and any hook processes it started (child.kill() alone leaves the tree running on Windows). */
function killTree(child: ChildProcess): void {
  if (process.platform === "win32" && child.pid) spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  else child.kill("SIGKILL");
}

function launch(agent: Agent, serverUrl: string, runDir: string, phase = "", followUp?: { sessionId: string; prompt: string }): { done: Promise<AgentResult>; kill: () => void } {
  const prompt = followUp
    ? [followUp.prompt, config.tasks[agent.task].suffix ?? config.promptSuffix].join("\n\n")
    : [config.tasks[agent.task].prompt, agent.promptAppend, config.tasks[agent.task].suffix ?? config.promptSuffix].filter(Boolean).join("\n\n");
  const args = [
    "-p",
    "--model", agent.model ?? process.env.LANES_MODEL ?? "haiku",
    "--output-format", "stream-json",
    "--verbose",
    "--max-budget-usd", String(agent.sessionCapUsd ?? SESSION_CAP_USD),
    "--permission-mode", "acceptEdits",
    "--setting-sources", "project",
    // No account-level MCP connectors (Slack, Shopify…) in either arm: they add noise to the agent's context (M.2).
    "--strict-mcp-config",
    "--disallowedTools", "WebFetch,WebSearch,Task,Agent",
    ...(agent.allowedTools?.length ? ["--allowedTools", agent.allowedTools.join(",")] : []),
    ...(followUp ? ["--resume", followUp.sessionId] : []),
  ];
  const started = Date.now();
  const streamFile = path.join(runDir, `agent-${agent.name}${phase}.jsonl`);
  const out = fs.createWriteStream(streamFile);
  const child = spawn(CLAUDE, args, { cwd: agent.cwd, env: childEnv(serverUrl, agent.user), windowsHide: true });
  let killed = false;
  const timer = setTimeout(() => {
    killed = true;
    killTree(child);
  }, agent.timeoutMs ?? AGENT_TIMEOUT_MS);
  child.stdout.pipe(out);
  let stderr = "";
  child.stderr.on("data", (d) => (stderr += d));
  child.stdin.end(prompt);

  const done = new Promise<AgentResult>((resolve) => {
    // "exit", not "close": orphaned hook processes can hold the stdout pipe open long after the agent exits.
    child.on("exit", (exitCode) => {
      clearTimeout(timer);
      // The pipe may already be closed by the time "exit" fires; otherwise give it 3 s, then force it.
      const whenOutputClosed = (fn: () => void) => {
        if (child.stdout?.closed ?? true) return fn();
        child.stdout?.once("close", fn);
        setTimeout(() => child.stdout?.destroy(), 3_000);
      };
      whenOutputClosed(() => out.end(() => {
        if (stderr) fs.writeFileSync(path.join(runDir, `agent-${agent.name}${phase}.stderr.txt`), stderr);
        const { messages, toolErrors, asksUser, result } = parseStream(streamFile);
        const costUsd = typeof result?.total_cost_usd === "number" ? result.total_cost_usd : 0;
        addSpend(costUsd, `${path.basename(runDir)}/${agent.name}${phase}`);
        resolve({
          name: agent.name + phase,
          user: agent.user,
          task: agent.task,
          sessionIds: [...new Set(messages.map((m) => m.session_id).filter(Boolean))] as string[],
          exitCode,
          killed,
          costUsd,
          durationMs: Date.now() - started,
          turns: result?.num_turns ?? 0,
          finalText: String(result?.result ?? "").slice(0, 2000),
          toolErrors,
          taskDone: false,
          failedChecks: [],
          unpublished: [],
          reapplies: 0,
          model: agent.model ?? process.env.LANES_MODEL ?? "haiku",
          asksUser,
        });
      }));
    });
  });
  return {
    done,
    kill: () => {
      killed = true;
      killTree(child);
    },
  };
}

async function waitFor(condition: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for: ${label}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

// ---------- verification ----------

function show(main: string, file: string): string | null {
  return tryGit(main, "show", `${INTEGRATION}:${file}`);
}

/** Runs a task's behaviour check against a checkout of the final lanes/main; returns the error, or null if it passed. */
function runCheck(main: string, code: string, rev = INTEGRATION): string | null {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lanes-check-"));
  try {
    git(main, "worktree", "add", "-q", "--detach", dir, rev);
    const res = spawnSync(process.execPath, ["--no-warnings", "--input-type=module", "-e", code], { cwd: dir, encoding: "utf8", timeout: 20_000 });
    if (res.status === 0) return null;
    // The error line, not node's echo of the check's source (L5 first attempt reported only the echo).
    const lines = (res.stderr || res.stdout || `exit ${res.status}`).trim().split("\n");
    const error = lines.find((l) => /^\s*\w*Error\b/.test(l)) ?? lines[lines.length - 1];
    return error.trim().slice(0, 500);
  } finally {
    tryGit(main, "worktree", "remove", "--force", dir);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function verify(main: string, agents: Agent[], results: AgentResult[], scenario: Scenario, serverLog: string) {
  const planted = Object.keys(scenario.plant ?? {});
  for (const agent of agents) {
    const task = config.tasks[agent.task];
    const failed = task.checks.filter((c) => !new RegExp(c.pattern).test(show(main, c.file) ?? ""));
    const ownLast = task.checkAt === "own-last" ? tryGit(main, "log", "-1", "--format=%H", `--author=${agent.user}`, INTEGRATION) : null;
    const runError = task.run ? runCheck(main, task.run, ownLast ?? INTEGRATION) : null;
    const laterBreak = task.run && ownLast ? runCheck(main, task.run) : null;
    if (runError) failed.push({ file: "(behaviour)", pattern: runError });
    // The planted files are the human's own: staying uncommitted is exactly right.
    const status = (tryGit(agent.cwd, "status", "--porcelain") ?? "").split("\n").filter((s) => s && !planted.some((f) => s.endsWith(f)));
    if (REMOTE) tryGit(agent.cwd, "fetch", "-q", "origin");
    const published = REMOTE ? `origin/${INTEGRATION}` : INTEGRATION;
    const unpushed = (tryGit(agent.cwd, "log", "--format=%h %s", `${published}..HEAD`) ?? "").split("\n").filter(Boolean);
    const reapplies = (tryGit(agent.cwd, "for-each-ref", "--format=%(refname)", "refs/lanes/backup/") ?? "").split("\n").filter(Boolean).length;
    for (const r of results.filter((r) => r.name.startsWith(agent.name))) {
      r.failedChecks = failed;
      r.taskDone = failed.length === 0;
      r.unpublished = [...status.map((s) => `uncommitted ${s}`), ...unpushed.map((s) => `unpublished ${s}`)];
      r.reapplies = reapplies;
      if (ownLast) r.laterChanges = laterBreak ? `broken by later changes: ${laterBreak}` : "still passes after later changes";
    }
  }
  // Security: nothing secret on the shared branch (files, names, messages) or in the server's log.
  const leaks: string[] = [];
  const tree = tryGit(main, "ls-tree", "-r", "--name-only", INTEGRATION) ?? "";
  for (const f of planted) if (tree.split("\n").includes(f)) leaks.push(`${f} published on lanes/main`);
  const messages = tryGit(main, "log", "--format=%B", INTEGRATION) ?? "";
  const contents = tryGit(main, "grep", "-I", "-F", "-l", "-e", "__never__", ...(scenario.secrets ?? []).flatMap((s) => ["-e", s]), INTEGRATION) ?? "";
  const log = fs.existsSync(serverLog) ? fs.readFileSync(serverLog, "utf8") : "";
  for (const secret of scenario.secrets ?? []) {
    if (messages.includes(secret)) leaks.push(`secret in a commit message: ${secret.slice(0, 6)}…`);
    if (log.includes(secret)) leaks.push(`secret in the server log: ${secret.slice(0, 6)}…`);
  }
  if (contents.trim()) leaks.push(`secret in published files: ${contents.trim().replace(/\n/g, ", ")}`);
  const changed = (tryGit(main, "diff", "--name-only", "main", INTEGRATION) ?? "").split("\n").filter((f) => f.endsWith(".ts"));
  const syntaxErrors = changed.flatMap((file) => {
    try {
      stripTypeScriptTypes(show(main, file) ?? "");
      return [];
    } catch (err) {
      return [{ file, error: String((err as Error).message).slice(0, 200) }];
    }
  });
  const commits = (tryGit(main, "log", "--format=%H%x1f%an%x1f%ae%x1f%(trailers:key=Lanes-Agent,valueonly,separator=;)%x1f%s", `main..${INTEGRATION}`) ?? "")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [sha, author, email, agentTrailer, subject] = line.split("\x1f");
      const files = (tryGit(main, "show", "--name-only", "--format=", sha) ?? "").split("\n").filter(Boolean);
      return { sha: sha.slice(0, 8), author, email, agentTrailer: agentTrailer.trim(), subject, files };
    });
  const graph = tryGit(main, "log", "--graph", "--format=%h %an: %s", INTEGRATION) ?? "";
  // Team-context signals, for the M.2 benchmark: path heads-ups delivered (and how many at read time), stale-dependency blocks.
  const entries = log.split("\n").flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
  const headsUps = entries.filter((e) => e.type === "team-context" && e.path && e.chars > 0);
  const signals = { headsUps: headsUps.length, readHeadsUps: headsUps.filter((e) => e.read).length, staleBlocks: entries.filter((e) => e.type === "observe" && e.kind === "stale-dependency").length };
  return { syntaxErrors, commits, graph, leaks, signals };
}

// ---------- scenario ----------

async function runOnce(id: string, scenario: Scenario, runNo: number, dry: boolean): Promise<void> {
  const label = `${new Date().toISOString().replace(/[:.]/g, "-")}-${id}-${ARM}-r${runNo}`;
  const runDir = path.join(RESULTS, label);
  fs.mkdirSync(runDir, { recursive: true });
  const work = fs.mkdtempSync(path.join(os.tmpdir(), `lanes-${id}-`));
  const { main, agents } = setUpRepo(work, scenario.agents);
  for (const a of agents) {
    a.promptAppend = scenario.promptAppend;
    a.allowedTools = scenario.allowedTools;
    a.sessionCapUsd ??= scenario.sessionCapUsd;
    a.timeoutMs = scenario.timeoutMin ? scenario.timeoutMin * 60_000 : undefined;
    for (const [file, content] of Object.entries(scenario.plant ?? {})) fs.writeFileSync(path.join(a.cwd, file), content);
  }
  const server: RunningServer = await startServer({
    port: 0,
    token: RUN_TOKEN,
    logFile: path.join(runDir, "server.jsonl"),
    coordinator: new Coordinator({ leaseTtlMs: scenario.ttlMs }),
    sweepIntervalMs: 1_000,
  });

  console.log(`\n▶ ${id} run ${runNo}: ${scenario.description}`);
  for (const a of agents) console.log(`  ${a.name}: ${a.task}`);
  if (dry) {
    console.log("  (dry run) repo, integration branch, worktrees and settings created; nothing launched");
    await server.close();
    if (process.argv.includes("--keep")) {
      // Manual testing (docs/engineering/macos-testing.md): leave the checkouts for interactive Claude Code sessions.
      console.log(`  kept: ${work}`);
      for (const a of agents) console.log(`    ${a.user}: cd "${a.cwd}"`);
      fs.rmSync(runDir, { recursive: true, force: true });
      return;
    }
    fs.rmSync(work, { recursive: true, force: true, maxRetries: 3 });
    fs.rmSync(runDir, { recursive: true, force: true });
    return;
  }

  const turns = (a: Agent) => 1 + (config.tasks[a.task].followUps?.length ?? 0);
  assertBudget(agents.reduce((sum, a) => sum + turns(a) * (a.sessionCapUsd ?? SESSION_CAP_USD), 0), agents.length);
  const results: AgentResult[] = [];
  const notes: string[] = [];
  // 127.0.0.2 is not "local" to the hook, so it won't auto-start a server there: coordination is really off.
  const agentUrl = scenario.serverDown ? "http://127.0.0.2:9" : server.url;
  if (scenario.killHolderFirst) {
    const [holder, waiter] = agents;
    const coordinator = server.coordinator;
    const first = launch(holder, agentUrl, runDir);
    await waitFor(() => coordinator.snapshot().leases.some((l) => l.user === holder.user), 3 * 60_000, "holder takes a lease");
    notes.push(`Killed ${holder.name} while it held: ${coordinator.snapshot().leases.map((l) => l.path).join(", ")}`);
    first.kill();
    const second = launch(waiter, agentUrl, runDir);
    results.push(await first.done, await second.done);
  } else {
    // Each agent: optional delayed start, its first prompt, then any follow-up prompts in the same session.
    const runAgent = async (a: Agent): Promise<AgentResult[]> => {
      if (a.delaySec) await new Promise((r) => setTimeout(r, a.delaySec! * 1000));
      const done = [await launch(a, agentUrl, runDir).done];
      for (const [i, prompt] of (config.tasks[a.task].followUps ?? []).entries()) {
        const last = done[done.length - 1];
        if (!last.sessionIds[0] || last.killed) break;
        done.push(await launch(a, agentUrl, runDir, `-turn${i + 2}`, { sessionId: last.sessionIds[0], prompt }).done);
      }
      return done;
    };
    results.push(...(await Promise.all(agents.map(runAgent))).flat());
  }

  const checks = verify(main, agents, results, scenario, path.join(runDir, "server.jsonl"));
  const snapshot = server.coordinator.snapshot();
  await server.close();

  const summary = { id, run: runNo, arm: ARM, scenario, notes, agents: results, ...checks, editors: snapshot.editors, tasks: snapshot.tasks, totalCostUsd: results.reduce((s, r) => s + r.costUsd, 0) };
  fs.writeFileSync(path.join(runDir, "summary.json"), JSON.stringify(summary, null, 2));
  for (const r of results) {
    const flags = [r.killed ? "killed" : "", r.taskDone ? "task ✓" : `task ✗ ${r.failedChecks.map((c) => c.file).join(",")}`, r.toolErrors.length ? `${r.toolErrors.length} tool errors` : "", r.unpublished.length ? `UNPUBLISHED ${r.unpublished.length}` : "", r.laterChanges ?? ""].filter(Boolean);
    console.log(`  ${r.name}: exit ${r.exitCode}, $${r.costUsd.toFixed(4)}, ${r.turns} turns, ${(r.durationMs / 1000).toFixed(0)}s · ${flags.join(" · ")}`);
  }
  console.log(`  lanes/main: ${checks.commits.length} commits by [${checks.commits.map((c) => c.author).join(", ")}]; syntax errors: ${checks.syntaxErrors.length}; leaks: ${checks.leaks.length}`);
  console.log(`  ledger total: $${spent().toFixed(4)}`);
  fs.rmSync(work, { recursive: true, force: true, maxRetries: 3 });
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (!fs.existsSync(HOOK)) throw new Error(`${HOOK} is missing: run npm run build first`);
  const dry = argv.includes("--dry");
  const runsFlag = argv.indexOf("--runs");
  const runsOverride = runsFlag >= 0 ? Number(argv[runsFlag + 1]) : undefined;
  const ids = argv.filter((a, i) => /^[A-Z]\d+$/.test(a) && !["--runs", "--arm"].includes(argv[i - 1]));
  if (ids.length === 0) throw new Error(`Usage: node runner/run.ts V1 [V2 ...] [--runs N] [--dry]. Scenarios: ${Object.keys(config.scenarios).join(", ")}`);
  fs.mkdirSync(RESULTS, { recursive: true });
  for (const id of ids) {
    const scenario = config.scenarios[id];
    if (!scenario) throw new Error(`Unknown scenario ${id}`);
    for (let run = 1; run <= (runsOverride ?? scenario.runs); run++) await runOnce(id, scenario, run, dry);
  }
}

main().catch((err: Error) => {
  console.error(err.message);
  process.exit(1);
});
