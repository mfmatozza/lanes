// Protocol types. See docs/architecture/protocol.md (v1) and docs/plans/phase-2b-spike-v2.md (v2 additions).

export type AgentStatus = "working" | "idle" | "blocked" | "waiting";

export interface AgentRef {
  user: string;
  sessionId: string;
  repo: string;
  label: string;
  root?: string;
}

export interface Agent extends AgentRef {
  status: AgentStatus;
  lastTool?: string;
  lastPath?: string;
  blockedOn?: string;
  edits: number;
  startedAt: number;
  lastSeen: number;
}

export interface Lease {
  repo: string;
  path: string;
  holder: string;
  user: string;
  acquiredAt: number;
  expiresAt: number;
}

export interface Task {
  id: string;
  repo: string;
  user: string;
  sessionId: string;
  title: string;
  predicted: string[];
  touched: string[];
  /** path → new-side line ranges this task changed there, from its publishes (line numbers only, never text). Absent: unknown. */
  ranges?: Record<string, LineRange[]>;
  status: "active" | "done";
  createdAt: number;
  doneAt?: number;
}

/** An inclusive [first, last] line range, 1-based. */
export type LineRange = [number, number];

export interface Overlap {
  taskId: string;
  user: string;
  title: string;
  files: string[];
}

export interface FileVersion {
  /** Integration-branch commit that contains the latest published change to this file. */
  commit: string;
  user: string;
}

/** A problem or notable event a hook reported (#130). Never file contents, prompts or shell commands. */
export interface HookEvent {
  /** Server time it was recorded. */
  at: number;
  kind: string;
  user?: string;
  sessionId?: string;
  repo?: string;
  path?: string;
  paths?: string[];
  /** Redacted by the hook, truncated by the server. */
  error?: string;
  waitedMs?: number;
}

/** Multiplayer (ADR-0028): a team chat message. Text is cleaned by the server; mentions are lower-case names or "team". */
export interface ChatMessage {
  id: string;
  repo: string;
  user: string;
  text: string;
  mentions: string[];
  at: number;
}

/** Multiplayer (ADR-0028): a request to a teammate's agent. It reaches that agent only after its own user approves. */
export interface AgentRequest {
  id: string;
  repo: string;
  from: string;
  to: string;
  text: string;
  scope: "read" | "edit";
  status: "pending" | "approved" | "denied" | "delivered" | "expired";
  createdAt: number;
  expiresAt: number;
  decidedAt?: number;
  /** What the receiver's agent answered, sent back by the receiver (cleaned, capped). The asker's agent sees it once. */
  reply?: string;
  repliedAt?: number;
}

export interface TeamState {
  chat: ChatMessage[];
  requests: AgentRequest[];
}

export interface Snapshot {
  agents: Agent[];
  leases: Lease[];
  tasks: Task[];
  /** repo → path → users who have published edits to it. */
  editors: Record<string, Record<string, string[]>>;
  /** Recent hook observations, oldest first: the last 200 per repository, see Coordinator.observe. */
  events: HookEvent[];
  /** repo → edits in the last 7 days that went ahead uncoordinated because the server was unreachable, as reported by hooks. Counts only; absent on older servers. */
  uncoordinated?: Record<string, number>;
  /** Multiplayer chat and open requests; absent on older servers. */
  team?: TeamState;
  serverTime: number;
}

export interface CheckRequest extends AgentRef {
  tool: string;
  paths: string[];
}

export type ReportRequest = CheckRequest;

export interface AcquireRequest extends CheckRequest {
  waitMs: number;
}

export interface SessionRequest extends AgentRef {
  event: "start" | "stop" | "end";
}

export interface PublishRequest extends AgentRef {
  /** Integration-branch commit after publishing, if anything was published. */
  commit?: string;
  /** Files changed by the published commits. */
  paths: string[];
  /** Files whose edit is done, so their leases are released. Defaults to `paths`. Other leases of the session stay (#90). */
  release?: string[];
  /** End of the agent's turn: completes its task and releases every lease of the session. Per-edit publishes leave it unset. */
  final?: boolean;
  /** path → line ranges the published commits changed in it (`git diff -U0`), for a finer heads-up. Optional. */
  ranges?: Record<string, LineRange[]>;
}

export interface TaskRequest extends AgentRef {
  title: string;
  predicted: string[];
}

export interface CheckResponse {
  decision: "allow" | "deny";
  reason?: string;
}

export type AcquireResponse =
  /** `epoch` changes whenever the server restarts: file versions from before are gone (#89). */
  | { decision: "allow"; waitedMs: number; versions: Record<string, FileVersion>; epoch: string }
  | { decision: "timeout"; waitedMs: number; reason: string };
