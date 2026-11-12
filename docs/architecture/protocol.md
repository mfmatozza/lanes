# Server protocol (v1)

> **Status:** Approved · **Owner:** @mfmatozza · **Last updated:** 2026-10-28
> [Docs](../README.md) › Architecture › Protocol · [← Coordination model](coordination-model.md) · [Agent integration →](agent-integration.md)

- **Transport:** HTTP/1.1 with JSON bodies, plus one WebSocket for state streaming.
- **Default address:** `http://127.0.0.1:4317`.
- **Versioning:** URL prefix `/v1`. Breaking changes require `/v2` and an ADR.

## Authentication
- **Every request except `GET /health` must send `Authorization: Bearer <token>`**, including requests to localhost ([ADR-0023](../design.md#adr-0023)). A local server's token is created in `~/.lanes` (private to the user) on first use.
- The `Host` header must be one the server expects, which blocks DNS rebinding. A loopback server accepts loopback names. A server bound beyond loopback (`LANES_HOST=0.0.0.0`) requires a token and also accepts the machine's own addresses, host name and `<host>.local` (and `<host>.<USERDNSDOMAIN>` on Windows), with or without a trailing dot, plus any names in `LANES_ALLOWED_HOSTS` (comma-separated). POSTs must be `application/json`.
- WebSocket clients pass the token as `Authorization: Bearer <token>` (clients that cannot set headers may use `?token=<token>`, which can end up in logs, so prefer the header). The `Host` check applies to the upgrade too, and so does an `Origin` check: a request that carries an `Origin` header (a browser page) is refused unless that origin's host is one the server expects.
- Without `--host`, the server binds to `127.0.0.1` only. See the [security model](security.md).

## Types

```ts
type AgentStatus = "working" | "idle" | "waiting";

interface AgentRef {
  user: string;        // human display name
  sessionId: string;   // agent session id (Claude Code session_id)
  repo: string;        // repository ID
  label: string;       // checkout/worktree folder name (never an absolute path)
  root?: string;       // local checkout path, for "open file" on the same machine
}

interface Agent extends AgentRef {
  status: AgentStatus;
  lastTool?: string;
  lastPath?: string;
  blockedOn?: string;
  edits: number;
  startedAt: number;   // epoch ms (server clock)
  lastSeen: number;
}

interface Lease { repo: string; path: string; holder: string; user: string; acquiredAt: number; expiresAt: number }

interface Task {
  id: string; repo: string; user: string; sessionId: string;
  title: string;            // first line of the prompt, max 120 chars
  predicted: string[];      // paths mentioned in the prompt
  touched: string[];        // paths edited so far
  status: "active" | "done";
  createdAt: number; doneAt?: number;
}

interface Overlap { taskId: string; user: string; title: string; files: string[] }
interface FileVersion { commit: string; user: string }   // latest published change to a file

// What a hook reported: never file contents, prompts or shell commands (#130)
interface HookEvent { at: number; kind: string; user?: string; sessionId?: string; repo?: string; path?: string; paths?: string[]; error?: string; waitedMs?: number }

interface Snapshot {
  agents: Agent[];
  leases: Lease[];
  tasks: Task[];                                       // every active task, and each user's latest 10 finished ones (#261)
  editors: Record<string, Record<string, string[]>>;   // repo -> path -> users who published edits to it
  events: HookEvent[];                                 // oldest first; the last 200 per repository, at most 500 in a snapshot
  uncoordinated?: Record<string, number>;              // repo -> edits in the last 7 days that went ahead without the server (counts only; absent on older servers)
  serverTime: number;
}
```

## Endpoints
All `POST` bodies carry `AgentRef` plus the fields shown. Every response is `200` JSON unless listed under [Errors](#errors).

### `GET /health`
Returns `200 {"ok": true}`. No authentication.

### `POST /v1/acquire`
Asks for the lease on `paths` before an edit. **Long-polls**: if another holder has it, the request waits in that file's queue and answers when the lease is granted or `waitMs` runs out. The server never answers "deny".

```jsonc
// request
{ "user": "Bea", "sessionId": "8f2c…", "repo": "github.com/acme/app", "label": "app",
  "tool": "Edit", "paths": ["src/auth/session.ts"], "waitMs": 240000 }   // waitMs capped at 240000
// response
{ "decision": "allow", "waitedMs": 480, "epoch": "6f1c…",
  "versions": { "src/auth/session.ts": { "commit": "9fceb0…", "user": "Ana" } } }
// or, when the wait ran out or the queue is full
{ "decision": "timeout", "waitedMs": 240000, "reason": "…" }
```
`versions` tells the hook which integration-branch commit holds the latest content, so it can sync before the edit. On `timeout` the hook goes ahead anyway. `epoch` identifies the server run: versions live in memory, so when it differs from the one a session saw last (a restart), the hook checks the integration tip once instead of trusting an empty `versions`.
If the client disconnects, the request leaves the queue.

### `POST /v1/publish`
Announces that an edit has been committed and pushed. Releases the holder's leases on `release` (default: `paths`), not its other leases (another edit of the same session may still be in flight), records the new `FileVersion`s and serves the next waiter.
Body: `{ commit?: string (40–64 hex), paths: string[], release?: string[], final?: boolean }`. A publish may name up to 5000 paths (other requests: 50; bodies up to 1 MB). `final` marks the end of the agent's turn, completes its task and releases every lease of the session. A publish that names no file at all (older clients) also releases everything.

### `POST /v1/task`
Creates a task from a prompt. Body: `{ title, predicted: string[] }`. Response: `{ task, overlaps: Overlap[] }`. Only the title and predicted paths are sent; the full prompt never leaves the machine.

### `POST /v1/hold`
Extends the agent's leases on `paths` for `holdMs` (capped at 30 min), while the user decides on an approval prompt.

### `POST /v1/session`
Lifecycle event: `AgentRef` plus `"event": "start" | "stop" | "end"`. `end` releases the session's leases.

### `POST /v1/release`
Manually releases a lease (from the editor). Body: `{ "repo", "path" }`. Response: `{ "released": true|false }`.

### `POST /v1/report`
Records activity for an edit that happened without an `acquire` (for example while coordination was off). Same body as `acquire`, without `waitMs`.

### `POST /v1/observe`
A hook reports something the views should flag. Body: `AgentRef`-like fields plus `kind` and optional `path`, `paths`, `error`, `waitedMs`. Only these kinds are kept: `sync-failed`, `sync-skipped`, `publish-*` (`publish-blocked`, `publish-add-failed`, `publish-conflict`, `publish-no-integration-branch`, `publish-retries-exhausted`, `publish-commit-failed`, `publish-commit-pending`), `wait-overrun`, `reapply`, `status-failed`. Everything else (the per-edit `synced` and `pulled` notes, shell commands) is dropped, as is any field not listed in `HookEvent`; strings are truncated (`error` to 300 characters). The server keeps a ring of the last 200 events per repository (at most 100 repositories) in memory and exposes them as `Snapshot.events`; a restart forgets them. Response: `{ "ok": true }`.

#### Uncoordinated edits
`POST /v1/observe` with `kind: "uncoordinated"` and `count` (a positive number, at most 1000 per report) and `repo`. A hook sends it on its next successful contact, to tell the server how many edits of that repository went ahead while the server was down, unreachable or too slow (fail open, [ADR-0019](../design.md#adr-0019)). It is **not** a flagged event: it is not kept in `events`; the server adds the counts per repository for one week and exposes the sum in `Snapshot.uncoordinated`. A report without a repository, or with a count that is not a positive number, is dropped. The server never receives paths, contents, prompts or names for this; the extension shows the total in the status bar tooltip ("N edits went ahead uncoordinated this week") when it is above zero. The hook's own record of these edits is the [local ledger](agent-integration.md#local-ledger-and-lanes-report), which never leaves the machine.

### `GET /v1/state`
Returns the current `Snapshot`.

### `WS /v1/events`
A WebSocket (RFC 6455, version 13) that streams the state, so a client need not poll `GET /v1/state`. Implemented with `node:http`'s `upgrade` event and a small frame codec (`@lanes/core/ws.ts`), with no dependency.

On connect, and after every state change (debounced by 50 ms), the server sends one text frame:
```json
{ "type": "snapshot", "snapshot": { "agents": [], "leases": [], "tasks": [], "editors": {}, "events": [], "serverTime": 1761134400000 } }
```
Clients use `serverTime` to correct for clock skew when showing "held for".

| Rule | Value |
|---|---|
| Refused before the upgrade | `401` wrong or missing token; `403` unexpected `Host` or `Origin`; `400` not a valid upgrade (method, version or key); `404` any path but `/v1/events`; `503` more than 128 open connections |
| Heartbeat | The server sends a ping every 20 s and closes a connection that has sent nothing (no pong, no frame) for 50 s |
| Client frames | Must be masked (RFC 6455). Clients only need to answer pings and may send pings or a close. A text or binary frame over 1 KB closes the connection with code `1009`; a malformed or fragmented frame closes it with `1002` |
| Slow clients | A connection with more than 2 MB waiting to be sent is dropped (it is only a view; it reconnects and gets a fresh snapshot) |
| Closing the server | Every WebSocket is closed, so nothing keeps listening |

**Clients fall back to polling.** The stream is an optimisation: a client that cannot connect (an old server, a proxy that blocks upgrades) or loses the connection keeps working by polling `GET /v1/state`, and retries the stream with exponential backoff.

### Removed since the first draft
`POST /v1/check` (allow/deny) is replaced by `acquire` and the route was deleted in #148. There is no deny in the protocol.

## Errors

| Status | Meaning |
|---|---|
| 400 | Malformed JSON or missing fields: `{"error": "…"}` |
| 401 | Missing or invalid token |
| 403 | `Host` header not expected by the server |
| 415 | `Content-Type` is not `application/json` |
| 404 | Unknown route |
| 413 | Body over 1 MB |
| 500 | Server bug (logged) |
