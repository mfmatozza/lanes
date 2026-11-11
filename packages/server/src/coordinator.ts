// Lease rules L1–L9 (docs/architecture/coordination-model.md §3), plus spike v2:
// waiting queues (ADR-0016), file versions for handoff sync (ADR-0015), editors (ADR-0017), tasks (ADR-0018).
import * as crypto from "node:crypto";
import type {
  AcquireRequest,
  AcquireResponse,
  Agent,
  AgentRef,
  CheckRequest,
  CheckResponse,
  FileVersion,
  HookEvent,
  Lease,
  LineRange,
  Overlap,
  PublishRequest,
  ReportRequest,
  SessionRequest,
  Snapshot,
  Task,
  TaskRequest,
} from "@lanes/core/types.ts";
import { mergeRanges } from "@lanes/core/ranges.ts";

// Files per task with line ranges kept (S6.1).
const MAX_RANGE_FILES = 200;

export interface CoordinatorOptions {
  /** How long a lease survives without activity from its holder. */
  leaseTtlMs?: number;
  /** How long an inactive agent holding no leases stays listed. */
  agentForgetMs?: number;
  now?: () => number;
}

export type CoordinatorEvent =
  | { type: "expired"; lease: Lease; holderEnded: boolean }
  | { type: "overlap"; task: Task; overlaps: Overlap[] }
  | { type: "changed" };

interface Waiter {
  req: AcquireRequest;
  enqueuedAt: number;
  resolve: (res: AcquireResponse) => void;
  timer: ReturnType<typeof setTimeout>;
}

const leaseKey = (repo: string, path: string) => `${repo}\u0000${path}`;

const MAX_WAITERS = 1_000;
const MAX_WAITERS_PER_SESSION = 4;
const MAX_TASKS = 1_000;
const MAX_EVENTS_PER_REPO = 200;
const MAX_EVENT_REPOS = 100;
const MAX_SNAPSHOT_EVENTS = 500;
const MAX_ENDED_SESSIONS = 10_000;
// shortcut: only problems and re-applies are kept; the per-edit "synced" and "pulled" notes would crowd them out of the ring.
const KEPT_EVENT = /^(sync-failed|sync-skipped|publish-.+|wait-overrun|reapply|status-failed)$/;
const clip = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : undefined);

export class Coordinator {
  /** Identifies this server run: file versions are in memory, so a new epoch means they were forgotten (#89). */
  readonly epoch = crypto.randomUUID();
  readonly leaseTtlMs: number;
  readonly agentForgetMs: number;
  private readonly now: () => number;
  private readonly agents = new Map<string, Agent>();
  private readonly leases = new Map<string, Lease>();
  private readonly versions = new Map<string, FileVersion>();
  private readonly editors = new Map<string, Set<string>>();
  private readonly tasks = new Map<string, Task>();
  private readonly waiters: Waiter[] = [];
  private readonly endedSessions = new Set<string>();
  private readonly listeners = new Set<(event: CoordinatorEvent) => void>();
  private readonly events = new Map<string, HookEvent[]>();
  /** repo → reports of edits that went ahead uncoordinated (the server was unreachable), kept one week. Counts only. */
  private readonly uncoordinatedReports = new Map<string, { at: number; count: number }[]>();
  private nextTaskId = 1;

  constructor(options: CoordinatorOptions = {}) {
    this.leaseTtlMs = options.leaseTtlMs ?? 10 * 60_000;
    this.agentForgetMs = options.agentForgetMs ?? 60 * 60_000;
    this.now = options.now ?? Date.now;
  }

  onEvent(listener: (event: CoordinatorEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** State kept beside the coordinator (the multiplayer team layer) changed: views refresh as for any change. */
  notifyChanged(): void {
    this.emit({ type: "changed" });
  }

  /**
   * Non-waiting check (spike v1): grants or renews leases on all paths, or denies (L1–L4, L9). Not exposed over HTTP any more
   * (#148): `acquire` replaced it. shortcut: kept as the primitive the coordinator unit tests use; fold them into `acquire` and delete it.
   */
  check(req: CheckRequest): CheckResponse {
    const now = this.now();
    const agent = this.touch(req, now);
    agent.lastTool = req.tool;
    agent.lastPath = req.paths[0];
    const conflicts = this.conflicts(req, now);
    if (conflicts.length > 0) {
      agent.status = "blocked";
      agent.blockedOn = conflicts[0].path;
      this.emit({ type: "changed" });
      return { decision: "deny", reason: this.denyReason(req, conflicts, now) };
    }
    this.grant(req, now);
    return { decision: "allow" };
  }

  /**
   * Waiting acquire (ADR-0016): grants immediately when free, otherwise queues first-come first-served
   * until the paths free up or `waitMs` passes. `signal` cancels a waiter whose hook went away.
   */
  acquire(req: AcquireRequest, signal?: AbortSignal): Promise<AcquireResponse> {
    const now = this.now();
    const agent = this.touch(req, now);
    agent.lastTool = req.tool;
    agent.lastPath = req.paths[0];
    if (this.conflicts(req, now).length === 0 && !this.queuedAhead(req)) {
      this.grant(req, now);
      return Promise.resolve({ decision: "allow", waitedMs: 0, versions: this.versionsFor(req), epoch: this.epoch });
    }
    // Bounded queue (security review). Past the bound the edit goes ahead, as after any long wait (ADR-0019).
    const mine = this.waiters.filter((w) => w.req.sessionId === req.sessionId).length;
    if (this.waiters.length >= MAX_WAITERS || mine >= MAX_WAITERS_PER_SESSION) {
      return Promise.resolve({ decision: "timeout", waitedMs: 0, reason: "queue full" });
    }
    agent.status = "waiting";
    agent.blockedOn = req.paths[0];
    this.emit({ type: "changed" });
    return new Promise((resolve) => {
      const waiter: Waiter = {
        req,
        enqueuedAt: now,
        resolve,
        timer: setTimeout(() => {
          this.dropWaiter(waiter);
          const holders = this.conflicts(req, this.now());
          agent.status = "working";
          agent.blockedOn = undefined;
          this.emit({ type: "changed" });
          resolve({ decision: "timeout", waitedMs: this.now() - waiter.enqueuedAt, reason: this.timeoutReason(req, holders) });
        }, req.waitMs),
      };
      signal?.addEventListener("abort", () => {
        clearTimeout(waiter.timer);
        this.dropWaiter(waiter);
      });
      this.waiters.push(waiter);
    });
  }

  /** Records a completed edit and renews the holder's leases on those paths (L3). */
  report(req: ReportRequest): void {
    const now = this.now();
    const agent = this.touch(req, now);
    agent.status = "working";
    agent.lastTool = req.tool;
    agent.lastPath = req.paths[0] ?? agent.lastPath;
    agent.edits += 1;
    for (const path of req.paths) {
      const lease = this.liveLease(req.repo, path, now);
      if (lease?.holder === req.sessionId) lease.expiresAt = now + this.leaseTtlMs;
    }
    this.emit({ type: "changed" });
  }

  /**
   * The holder's edit is waiting for its user's approval (PermissionRequest hook): keep the lease for `holdMs`
   * instead of the normal TTL, so a slow approval doesn't let it expire under a live agent (spike v3 risk 3).
   * The publish after the edit, or the end of the turn, still releases it.
   */
  hold(req: CheckRequest, holdMs: number): void {
    const now = this.now();
    for (const path of req.paths) {
      const lease = this.liveLease(req.repo, path, now);
      if (lease?.holder === req.sessionId) lease.expiresAt = now + holdMs;
    }
    this.emit({ type: "changed" });
  }

  /**
   * An edit was published (ADR-0015/0016): record versions and editors, release the session's leases so the
   * next waiter is served. `final` marks the end of the turn, which also completes the session's task.
   */
  publish(req: PublishRequest): void {
    const now = this.now();
    const agent = this.touch(req, now);
    if (req.commit) {
      agent.edits += 1;
      for (const path of req.paths) {
        const key = leaseKey(req.repo, path);
        this.versions.set(key, { commit: req.commit, user: req.user });
        const users = this.editors.get(key) ?? new Set<string>();
        users.add(req.user);
        this.editors.set(key, users);
      }
    }
    if (req.commit && req.ranges) {
      // Union with the task's earlier publishes of the file: each publish only carries its own commits' lines.
      // shortcut: ranges are from the teammate's publishes and drift with later edits; map through git when it matters.
      for (const task of this.tasks.values()) {
        if (task.sessionId !== req.sessionId || task.status !== "active") continue;
        const ranges = (task.ranges ??= Object.create(null) as Record<string, LineRange[]>);
        for (const path of Object.keys(req.ranges)) {
          // Bounded per task; a file past the cap has no ranges, so its heads-up stays file-level.
          if (!ranges[path] && Object.keys(ranges).length >= MAX_RANGE_FILES) continue;
          ranges[path] = mergeRanges([...(ranges[path] ?? []), ...req.ranges[path]]);
        }
      }
    }
    if (req.final) {
      for (const task of this.tasks.values()) {
        if (task.sessionId === req.sessionId && task.status === "active") {
          task.status = "done";
          task.doneAt = now;
          delete task.ranges; // bounded memory and snapshot size; a finished task's heads-up is file-level
        }
      }
    }
    agent.status = req.final ? "idle" : "working";
    agent.blockedOn = undefined;
    // Only the finished edits: another edit of this session may still be in flight (#90). The end of the turn frees
    // all. A publish naming nothing (an older client) still frees everything, as before.
    const done = req.release ?? req.paths;
    if (req.final || done.length === 0) this.releaseHolder(req.sessionId);
    else this.releaseHolder(req.sessionId, new Set([...done, ...req.paths]), req.repo);
    this.emit({ type: "changed" });
  }

  /** Session lifecycle. `end` releases everything the session holds (L6). */
  session(req: SessionRequest): void {
    const now = this.now();
    if (req.event === "end") {
      this.endedSessions.add(req.sessionId);
      // Only read for leases that expire after their holder ended (TTL minutes): the oldest go, or every session ever ended stays in memory (#261).
      if (this.endedSessions.size > MAX_ENDED_SESSIONS) this.endedSessions.delete(this.endedSessions.values().next().value!);
      this.agents.delete(req.sessionId);
      for (const waiter of [...this.waiters]) {
        if (waiter.req.sessionId === req.sessionId) {
          clearTimeout(waiter.timer);
          this.dropWaiter(waiter);
        }
      }
      this.releaseHolder(req.sessionId);
      this.emit({ type: "changed" });
      return;
    }
    const agent = this.touch(req, now);
    agent.status = "idle";
    agent.blockedOn = undefined;
    this.emit({ type: "changed" });
  }

  /** A prompt became a task (ADR-0018). Returns the active tasks it overlaps with. */
  createTask(req: TaskRequest): { task: Task; overlaps: Overlap[] } {
    const now = this.now();
    this.touch(req, now);
    const task: Task = {
      id: `t${this.nextTaskId++}`,
      repo: req.repo,
      user: req.user,
      sessionId: req.sessionId,
      title: clean(req.title),
      predicted: req.predicted,
      touched: [],
      status: "active",
      createdAt: now,
    };
    this.tasks.set(task.id, task);
    // Bounded history (security review): forget the oldest finished tasks.
    for (const [id, old] of this.tasks) {
      if (this.tasks.size <= MAX_TASKS) break;
      if (old.status === "done") this.tasks.delete(id);
    }
    const overlaps = this.overlapsFor(task);
    if (overlaps.length > 0) this.emit({ type: "overlap", task, overlaps });
    this.emit({ type: "changed" });
    return { task, overlaps };
  }

  /** Manual release by a human (L7). */
  release(repo: string, path: string): boolean {
    const released = this.leases.delete(leaseKey(repo, path));
    if (released) {
      this.serveQueue();
      this.emit({ type: "changed" });
    }
    return released;
  }

  /** Drops expired leases (L5), serves waiters, and forgets long-inactive agents. */
  sweep(): void {
    const now = this.now();
    let changed = false;
    for (const [key, lease] of this.leases) {
      if (lease.expiresAt > now) continue;
      this.leases.delete(key);
      this.emit({ type: "expired", lease, holderEnded: this.endedSessions.has(lease.holder) });
      changed = true;
    }
    if (changed) this.serveQueue();
    const holders = new Set([...this.leases.values()].map((l) => l.holder));
    for (const [id, agent] of this.agents) {
      if (now - agent.lastSeen > this.agentForgetMs && !holders.has(id)) {
        this.agents.delete(id);
        changed = true;
      }
    }
    if (changed) this.emit({ type: "changed" });
  }

  /**
   * Records what a hook reported (#130): a bounded ring per repository, only whitelisted fields (so never a shell
   * command, file contents or a prompt) and only the kinds the views flag. Anything else is dropped.
   */
  observe(fields: Record<string, unknown>): void {
    const kind = clip(fields.kind, 64);
    if (kind === "uncoordinated") return this.addUncoordinated(clip(fields.repo, 512), fields.count);
    if (!kind || !KEPT_EVENT.test(kind)) return;
    const paths = Array.isArray(fields.paths) ? fields.paths.filter((p): p is string => typeof p === "string").slice(0, 20).map((p) => p.slice(0, 512)) : undefined;
    const event: HookEvent = {
      at: this.now(),
      kind,
      user: clip(fields.user, 200),
      sessionId: clip(fields.sessionId, 200),
      repo: clip(fields.repo, 512),
      path: clip(fields.path, 512),
      paths,
      error: clip(fields.error, 300),
      waitedMs: typeof fields.waitedMs === "number" ? fields.waitedMs : undefined,
    };
    const key = event.repo ?? "";
    const ring = this.events.get(key) ?? [];
    this.events.delete(key); // re-inserted last: the repository with the oldest activity is the one evicted
    ring.push(event);
    if (ring.length > MAX_EVENTS_PER_REPO) ring.shift();
    this.events.set(key, ring);
    if (this.events.size > MAX_EVENT_REPOS) this.events.delete(this.events.keys().next().value!);
    this.emit({ type: "changed" });
  }

  /** A hook, back in contact, says how many edits went ahead without the server (never paths). Bounded: 1000 per report, 100 repositories. */
  private addUncoordinated(repo: string | undefined, count: unknown): void {
    if (!repo || typeof count !== "number" || !Number.isFinite(count) || count < 1) return;
    const list = this.uncoordinatedReports.get(repo) ?? [];
    list.push({ at: this.now(), count: Math.min(Math.floor(count), 1_000) });
    this.uncoordinatedReports.set(repo, list.slice(-1_000));
    if (this.uncoordinatedReports.size > MAX_EVENT_REPOS) this.uncoordinatedReports.delete(this.uncoordinatedReports.keys().next().value!);
    this.emit({ type: "changed" });
  }

  snapshot(): Snapshot {
    const now = this.now();
    const uncoordinated: Record<string, number> = Object.create(null);
    for (const [repo, list] of this.uncoordinatedReports) {
      const week = list.filter((r) => r.at > now - 7 * 24 * 3_600_000);
      if (week.length < list.length) this.uncoordinatedReports.set(repo, week);
      const n = week.reduce((sum, r) => sum + r.count, 0);
      if (n > 0) uncoordinated[repo] = n;
    }
    // Null-prototype objects: repo and path come from requests, and "__proto__" must stay a plain key
    // (security review: a crafted publish polluted Object.prototype through this map).
    const editors: Snapshot["editors"] = Object.create(null);
    for (const [key, users] of this.editors) {
      const [repo, path] = key.split("\u0000");
      (editors[repo] ??= Object.create(null))[path] = [...users];
    }
    return {
      agents: [...this.agents.values()],
      leases: [...this.leases.values()].filter((l) => l.expiresAt > now),
      tasks: [...this.tasks.values()],
      editors,
      events: [...this.events.values()].flat().sort((a, b) => a.at - b.at).slice(-MAX_SNAPSHOT_EVENTS),
      uncoordinated,
      serverTime: now,
    };
  }

  private grant(req: CheckRequest, now: number): void {
    for (const path of req.paths) {
      const existing = this.liveLease(req.repo, path, now);
      this.leases.set(leaseKey(req.repo, path), {
        repo: req.repo,
        path,
        holder: req.sessionId,
        user: req.user,
        acquiredAt: existing?.acquiredAt ?? now,
        expiresAt: now + this.leaseTtlMs,
      });
    }
    for (const task of this.tasks.values()) {
      if (task.sessionId !== req.sessionId || task.status !== "active") continue;
      for (const path of req.paths) if (!task.touched.includes(path)) task.touched.push(path);
    }
    const agent = this.agents.get(req.sessionId);
    if (agent) {
      agent.status = "working";
      agent.blockedOn = undefined;
    }
    this.emit({ type: "changed" });
  }

  private releaseHolder(sessionId: string, only?: Set<string>, repo?: string): void {
    let released = false;
    for (const [key, lease] of this.leases) {
      if (lease.holder === sessionId && (!only || (lease.repo === repo && only.has(lease.path)))) {
        this.leases.delete(key);
        released = true;
      }
    }
    if (released) this.serveQueue();
  }

  /** Grants queued requests in arrival order whenever their paths are free. */
  private serveQueue(): void {
    const now = this.now();
    for (const waiter of [...this.waiters]) {
      if (this.conflicts(waiter.req, now).length > 0 || this.queuedAhead(waiter.req, waiter)) continue;
      clearTimeout(waiter.timer);
      this.dropWaiter(waiter);
      this.grant(waiter.req, now);
      waiter.resolve({ decision: "allow", waitedMs: now - waiter.enqueuedAt, versions: this.versionsFor(waiter.req), epoch: this.epoch });
    }
  }

  /**
   * True if another session is already waiting for any of these paths (no queue jumping). Paths the requester
   * already holds don't count: making a holder queue behind someone waiting for its own file is a deadlock.
   */
  private queuedAhead(req: CheckRequest, self?: Waiter): boolean {
    const now = this.now();
    const wanted = req.paths.filter((p) => this.liveLease(req.repo, p, now)?.holder !== req.sessionId);
    if (wanted.length === 0) return false;
    for (const waiter of this.waiters) {
      if (waiter === self) return false;
      if (waiter.req.sessionId === req.sessionId || waiter.req.repo !== req.repo) continue;
      if (waiter.req.paths.some((p) => wanted.includes(p))) return true;
    }
    return false;
  }

  private dropWaiter(waiter: Waiter): void {
    const index = this.waiters.indexOf(waiter);
    if (index >= 0) this.waiters.splice(index, 1);
  }

  private conflicts(req: CheckRequest, now: number): Lease[] {
    return req.paths
      .map((p) => this.liveLease(req.repo, p, now))
      .filter((l): l is Lease => l !== undefined && l.holder !== req.sessionId);
  }

  private versionsFor(req: CheckRequest): Record<string, FileVersion> {
    const versions: Record<string, FileVersion> = Object.create(null);
    for (const path of req.paths) {
      const version = this.versions.get(leaseKey(req.repo, path));
      if (version) versions[path] = version;
    }
    return versions;
  }

  private overlapsFor(task: Task): Overlap[] {
    const mine = new Set([...task.predicted, ...task.touched]);
    const overlaps: Overlap[] = [];
    for (const other of this.tasks.values()) {
      if (other.id === task.id || other.status !== "active" || other.repo !== task.repo || other.sessionId === task.sessionId) continue;
      const files = [...new Set([...other.predicted, ...other.touched])].filter((f) => mine.has(f));
      if (files.length > 0) overlaps.push({ taskId: other.id, user: other.user, title: other.title, files });
    }
    return overlaps;
  }

  private liveLease(repo: string, path: string, now: number): Lease | undefined {
    const lease = this.leases.get(leaseKey(repo, path));
    return lease && lease.expiresAt > now ? lease : undefined;
  }

  private touch(ref: AgentRef, now: number): Agent {
    let agent = this.agents.get(ref.sessionId);
    if (!agent) {
      // Named fields only: the request body may carry anything (security review).
      const { user, sessionId, repo, label } = ref;
      agent = { user, sessionId, repo, label, status: "idle", edits: 0, startedAt: now, lastSeen: now };
      this.agents.set(ref.sessionId, agent);
    }
    agent.lastSeen = now;
    agent.label = ref.label;
    return agent;
  }

  private denyReason(req: CheckRequest, conflicts: Lease[], now: number): string {
    const lines = conflicts.map((lease) => {
      const minutes = Math.max(1, Math.ceil((lease.expiresAt - now) / 60_000));
      return `- \`${clean(lease.path)}\` is being edited by ${this.describeHolder(lease, req)} (lease expires in ~${minutes} min unless renewed)`;
    });
    return [
      "Lanes blocked this edit to avoid colliding with another agent:",
      ...lines,
      "Do not work around this (for example by writing the file from a shell command). " +
        "Continue with parts of your task that don't touch these files and retry later.",
    ].join("\n");
  }

  private timeoutReason(req: CheckRequest, holders: Lease[]): string {
    const who = holders.map((l) => `\`${clean(l.path)}\` (${this.describeHolder(l, req)})`).join(", ") || "these files";
    return (
      `${who} is being changed by a teammate right now. ` +
      "Continue with parts of your task that don't need it, then try this edit again. " +
      "Do not write the file another way."
    );
  }

  private describeHolder(lease: Lease, req: CheckRequest): string {
    const holder = this.agents.get(lease.holder);
    const where = holder ? ` in "${clean(holder.label)}"` : "";
    if (lease.user === req.user) return `another of ${clean(lease.user)}'s agents${where}`;
    return `${clean(lease.user)}'s agent${where}`;
  }

  private emit(event: CoordinatorEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}

/** Text read by other agents: strip anything that could smuggle instructions or break formatting. */
function clean(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f`]/g, " ").replace(/\s+/g, " ").trim().slice(0, 120);
}
