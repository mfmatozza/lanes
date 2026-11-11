// HTTP server for protocol v1 (no WebSocket in the spike). Every request is appended to a JSONL log
// with its server-side latency, for the spike's measurements.
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import type { Duplex } from "node:stream";
import { APP_FILES } from "./app.ts";
import { Coordinator } from "./coordinator.ts";
import { GitHubLogin } from "./login.ts";
import { Members } from "./members.ts";
import { Team, type Who } from "@lanes/team/team.ts";
import { acceptKey, CLOSE, encodeFrame, FrameParser, OP, validKey, WsError } from "@lanes/core/ws.ts";
import { MAX_RANGES, mergeRanges } from "@lanes/core/ranges.ts";
import type { AcquireRequest, CheckRequest, LineRange, PublishRequest, SessionRequest, Task, TaskRequest } from "@lanes/core/types.ts";

export interface ServerOptions {
  port: number;
  host?: string;
  /**
   * Extra Host header names to accept. A server bound beyond loopback also accepts the machine's own addresses and
   * host name (teammates connect by IP or name); a loopback-only one accepts loopback names only (DNS rebinding).
   */
  allowedHosts?: string[];
  /** Bearer token every request must carry. Unset only in tests that run the server in-process. */
  token?: string;
  /** Where member token hashes are kept (ADR-0030). Unset: in memory only. */
  membersFile?: string;
  logFile?: string;
  coordinator?: Coordinator;
  team?: Team;
  sweepIntervalMs?: number;
  /** Public OAuth client id of a GitHub app with device flow on (ADR-0031). Unset: GitHub sign-in is off. */
  githubClientId?: string;
  /** GitHub's web and API base URLs; tests point them at a mock. */
  githubWeb?: string;
  githubApi?: string;
  /** Ping interval of the /v1/events stream; a client silent for 2.5 intervals is dropped. Default 20 s. */
  heartbeatMs?: number;
}

export interface RunningServer {
  url: string;
  coordinator: Coordinator;
  /** Time of the last request (ms epoch), so an auto-started server can exit when idle. */
  lastActivity(): number;
  close(): Promise<void>;
}

// Limits (security review, spike v3c): requests are small; anything bigger is abuse.
const MAX_BODY = 1_000_000;
const MAX_STRING = 512;
const MAX_PATHS = 50;
// A publish lists every file its commits changed (a generator can add hundreds), so it has its own, higher cap (#101).
const MAX_PUBLISH_PATHS = 5_000;
// The snapshot stream (#48): clients only send pongs, so frames over 1 KB are abuse; a slow reader is dropped, not buffered.
// 128: a team of 30 with the browser app and two VS Code windows each is 90 streams (#261); at 2 MB of backlog each, a
// worst case of 256 MB if every one stops reading. shortcut: one cap per server; add a per-member cap if one member's clients crowd out the rest.
const MAX_STREAMS = 128;
const MAX_STREAM_FRAME = 1024;
const MAX_STREAM_BACKLOG = 2_000_000;
const COMMIT_ID = /^[0-9a-f]{40,64}$/;
// Finished tasks per person in a snapshot; the VS Code task board shows 3 (DONE_SHOWN).
const DONE_TASKS_SHOWN = 10;
const LOOPBACK = ["127.0.0.1", "localhost", "::1"];
const bareHost = (h: string) => h.replace(/^\[|\]$/g, "").toLowerCase();

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export async function startServer(options: ServerOptions): Promise<RunningServer> {
  // A LAN server without a token would be open to the whole network.
  if (!LOOPBACK.includes(bareHost(options.host ?? "127.0.0.1")) && options.token === undefined) {
    throw new Error("a server bound beyond loopback requires a token");
  }
  const coordinator = options.coordinator ?? new Coordinator();
  const team = options.team ?? new Team();
  const members = new Members(options.membersFile);
  const github = new GitHubLogin({ clientId: options.githubClientId, web: options.githubWeb, api: options.githubApi }, members);
  const snapshot = () => {
    const full = coordinator.snapshot();
    return { ...full, tasks: recentTasks(full.tasks), team: team.state() };
  };
  const log = (entry: Record<string, unknown>) => {
    if (options.logFile) fs.appendFileSync(options.logFile, JSON.stringify({ t: Date.now(), ...entry }) + "\n");
  };
  coordinator.onEvent((event) => {
    if (event.type === "expired") log({ type: "expired", ...event.lease, holderEnded: event.holderEnded });
    if (event.type === "overlap") log({ type: "overlap", task: event.task, overlaps: event.overlaps });
  });

  let lastActivity = Date.now();
  const server = http.createServer((req, res) => {
    lastActivity = Date.now();
    // The browser app's static files (ADR-0029): no token (they hold no data), but the same Host check.
    const pathname = URL.parse(req.url ?? "/", "http://localhost")?.pathname ?? ""; // no throw here: outside handle()'s catch
    if ((req.method === "GET" || req.method === "HEAD") && Object.hasOwn(APP_FILES, pathname)) {
      if (!hostAllowed(req, options)) return send(res, 403, { error: "unexpected Host header" });
      res.writeHead(200, APP_FILES[pathname].headers);
      return void res.end(req.method === "HEAD" ? undefined : APP_FILES[pathname].body);
    }
    const started = performance.now();
    // Cancels a queued acquire if the hook goes away (e.g. the agent was killed).
    const disconnected = new AbortController();
    res.on("close", () => {
      if (!res.writableFinished) disconnected.abort();
    });
    handle(req, disconnected.signal)
      .then(({ status, body, entry }) => {
        send(res, status, body);
        if (entry) log({ ...entry, ms: +(performance.now() - started).toFixed(3) });
      })
      .catch((err: unknown) => {
        const status = err instanceof HttpError ? err.status : 500;
        send(res, status, { error: err instanceof Error ? err.message : String(err) });
      });
  });

  // WebSocket snapshot stream. Same checks as any request (Host, token) plus Origin: a browser page always sends one.
  const streams = new Set<Duplex>();
  const heartbeatMs = options.heartbeatMs ?? 20_000;
  const snapshotFrame = () => encodeFrame(OP.text, Buffer.from(JSON.stringify({ type: "snapshot", snapshot: snapshot() })));
  // A slow reader is dropped, not buffered.
  const sendFrame = (socket: Duplex, frame: Buffer) => {
    if (socket.destroyed) return;
    if (socket.writableLength > MAX_STREAM_BACKLOG) return socket.destroy();
    socket.write(frame);
  };
  // Debounced by 50 ms (ADR-0011), and built once per change for every viewer: per-stream builds cost O(viewers x snapshot) (#261).
  let broadcastTimer: ReturnType<typeof setTimeout> | undefined;
  const stopBroadcast = coordinator.onEvent((event) => {
    if (event.type !== "changed" || streams.size === 0) return;
    broadcastTimer ??= setTimeout(() => {
      broadcastTimer = undefined;
      const frame = snapshotFrame();
      for (const socket of streams) sendFrame(socket, frame);
    }, 50);
  });
  const refuse = (socket: Duplex, status: number, message: string) => {
    socket.end(`HTTP/1.1 ${status} ${message}\r\nconnection: close\r\ncontent-length: 0\r\n\r\n`);
  };
  server.on("upgrade", (req, socket: Duplex) => {
    socket.on("error", () => socket.destroy());
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.pathname !== "/v1/events") return refuse(socket, 404, "Not Found");
      // A browser cannot set headers on a WebSocket, so the token may come as ?token= too.
      checkCaller(req, options, members, url.searchParams.get("token") ?? undefined);
      const origin = req.headers.origin;
      if (origin !== undefined && !allowedHostNames(options).includes(bareHost(originHost(origin)))) throw new HttpError(403, "unexpected Origin");
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 400;
      return refuse(socket, status, status === 401 ? "Unauthorized" : status === 403 ? "Forbidden" : "Bad Request");
    }
    const key = req.headers["sec-websocket-key"];
    if (req.method !== "GET" || req.headers["sec-websocket-version"] !== "13" || !validKey(key)) return refuse(socket, 400, "Bad Request");
    if (streams.size >= MAX_STREAMS) return refuse(socket, 503, "Service Unavailable");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\nsec-websocket-accept: ${acceptKey(key)}\r\n\r\n`);
    streams.add(socket);
    const forget = () => {
      clearInterval(ping);
      streams.delete(socket);
    };
    const closeWith = (code: number) => {
      forget();
      if (!socket.destroyed) socket.end(encodeFrame(OP.close, Buffer.from([code >> 8, code & 255])));
      setTimeout(() => socket.destroy(), 1_000).unref();
    };
    let lastHeard = Date.now();
    const ping = setInterval(() => {
      if (Date.now() - lastHeard > heartbeatMs * 2.5) return socket.destroy();
      socket.write(encodeFrame(OP.ping));
    }, heartbeatMs);
    const parser = new FrameParser(MAX_STREAM_FRAME, true);
    socket.on("data", (chunk: Buffer) => {
      lastHeard = Date.now();
      try {
        for (const frame of parser.push(chunk)) {
          if (frame.opcode === OP.ping) socket.write(encodeFrame(OP.pong, frame.payload));
          else if (frame.opcode === OP.close) return closeWith(CLOSE.normal);
        }
      } catch (err) {
        closeWith(err instanceof WsError ? err.code : CLOSE.protocol);
      }
    });
    socket.on("close", forget);
    sendFrame(socket, snapshotFrame());
  });

  async function handle(req: http.IncomingMessage, signal: AbortSignal) {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (req.method === "GET" && url.pathname === "/health") return { status: 200, body: { ok: true } };
    // Sign-in (ADR-0031) is how a caller gets a token, so it takes none; the Host and content-type checks still apply.
    const login = url.pathname.startsWith("/v1/login/");
    if (login && !hostAllowed(req, options)) throw new HttpError(403, "unexpected Host header");
    // undefined: the admin (the server's own token); else the member this token belongs to.
    const member = login ? undefined : checkCaller(req, options, members);
    if (req.method === "POST" && !/^application\/json\b/i.test(req.headers["content-type"] ?? "")) {
      throw new HttpError(415, "content-type must be application/json");
    }
    if (login) {
      if (req.method === "GET" && url.pathname === "/v1/login/config") return { status: 200, body: { github: github.enabled } };
      if (req.method === "POST" && url.pathname === "/v1/login/github/start") return github.start(req.socket.remoteAddress ?? "");
      if (req.method === "POST" && url.pathname === "/v1/login/github/poll") return github.poll((await readJson(req)).loginId);
      throw new HttpError(404, "not found");
    }
    if (req.method === "GET" && url.pathname === "/v1/state") return { status: 200, body: snapshot() };
    if (req.method !== "POST") throw new HttpError(404, "not found");
    const body = await readJson(req);
    // A member is who their token says, whatever name the client sends (ADR-0030).
    if (member !== undefined) body.user = member;
    if (url.pathname === "/v1/members/whoami") {
      if (member === undefined) throw new HttpError(403, "only a personal token has a name");
      return { status: 200, body: { name: member } };
    }
    // The admin is the server's own token used on the server's own machine: a teammate holding the shared LAN token
    // cannot invite themselves or act as someone else (ADR-0031).
    const admin = member === undefined && fromThisMachine(req.socket.remoteAddress);
    if (url.pathname.startsWith("/v1/members/") && !admin) throw new HttpError(403, "only the server's own token, on the server's machine, can manage members");
    // Leases and checkpoints still take the shared token, so no edit is ever blocked (ADR-0019).
    if (url.pathname.startsWith("/v1/team/") && member === undefined && !admin && members.size > 0) throw new HttpError(403, "this team uses personal tokens: run lanes login or lanes join");
    switch (url.pathname) {
      case "/v1/acquire": {
        const acquireReq = asCheck(body) as AcquireRequest;
        acquireReq.waitMs = Math.min(Math.max(Number(body.waitMs) || 0, 0), 240_000);
        const result = await coordinator.acquire(acquireReq, signal);
        return { status: 200, body: result, entry: { type: "acquire", ...body, decision: result.decision, waitedMs: result.waitedMs } };
      }
      case "/v1/publish": {
        requireStrings(body, ["user", "sessionId", "repo", "label"]);
        if (body.commit !== undefined && (typeof body.commit !== "string" || !COMMIT_ID.test(body.commit))) throw new HttpError(400, "invalid commit");
        const publishReq = { ...body, paths: body.paths === undefined ? [] : asPaths(body.paths, MAX_PUBLISH_PATHS), release: body.release === undefined ? undefined : asPaths(body.release, MAX_PUBLISH_PATHS), ranges: body.ranges === undefined ? undefined : asRangeMap(body.ranges) } as unknown as PublishRequest;
        coordinator.publish(publishReq);
        return { status: 200, body: { ok: true }, entry: { type: "publish", ...body } };
      }
      case "/v1/task": {
        requireStrings(body, ["user", "sessionId", "repo", "label", "title"]);
        const taskReq = { ...body, predicted: body.predicted === undefined ? [] : asPaths(body.predicted) } as unknown as TaskRequest;
        const result = coordinator.createTask(taskReq);
        return { status: 200, body: result, entry: { type: "task", ...body, taskId: result.task.id, overlaps: result.overlaps } };
      }
      case "/v1/hold": {
        const holdMs = Math.min(Math.max(Number(body.holdMs) || 0, 0), 30 * 60_000);
        coordinator.hold(asCheck(body), holdMs);
        return { status: 200, body: { ok: true }, entry: { type: "hold", ...body } };
      }
      case "/v1/report":
        coordinator.report(asCheck(body));
        return { status: 200, body: { ok: true }, entry: { type: "report", ...body } };
      case "/v1/session":
        coordinator.session(asSession(body));
        return { status: 200, body: { ok: true }, entry: { type: "session", ...body } };
      case "/v1/release": {
        const { repo, path } = requireStrings(body, ["repo", "path"]);
        const released = coordinator.release(repo, path);
        return { status: 200, body: { released }, entry: { type: "release", ...body, released } };
      }
      case "/v1/observe":
        // Hook-side problems (sync/publish failures) are kept in the coordinator for the views (#130); the log also gets
        // the spike-only shell commands an agent attempted.
        coordinator.observe(body);
        return { status: 200, body: { ok: true }, entry: { type: "observe", ...body } };
      // Multiplayer (ADR-0028). Chat and request text is never written to the log, only that it happened.
      case "/v1/team/context": {
        const who = asWho(body);
        const path = body.path === undefined ? undefined : asPaths([body.path], 1)[0];
        const range = body.range === undefined || body.range === null ? undefined : asRange(body.range);
        const deliver: string[] = [];
        const text = team.context(who, coordinator.snapshot(), path, deliver, path ? range : undefined);
        return { status: 200, body: { text, deliver }, entry: { type: "team-context", user: who.user, sessionId: who.sessionId, path, read: body.read === true || undefined, chars: text.length, deliver } };
      }
      case "/v1/team/ack": {
        const who = asWho(body);
        const ids = Array.isArray(body.ids) ? body.ids.filter((id): id is string => typeof id === "string" && id.length <= 64).slice(0, 50) : [];
        const acked = team.ack(who, ids);
        if (acked > 0) coordinator.notifyChanged();
        return { status: 200, body: { acked }, entry: { type: "team-ack", user: who.user, ids, acked } };
      }
      case "/v1/team/say": {
        const who = asWho(body);
        const message = teamCall(() => team.say(who, body.text as string));
        coordinator.notifyChanged();
        return { status: 200, body: message, entry: { type: "team-say", user: who.user, mentions: message.mentions } };
      }
      case "/v1/team/ask": {
        const who = asWho(body);
        const request = teamCall(() => team.ask(who, body.to as string, body.text as string, body.scope === "edit" ? "edit" : "read"));
        coordinator.notifyChanged();
        return { status: 200, body: request, entry: { type: "team-ask", user: who.user, to: request.to, id: request.id, scope: request.scope } };
      }
      case "/v1/team/decide": {
        const who = asWho(body);
        const { id } = requireStrings(body, ["id"]);
        const request = teamCall(() => team.decide(who, id, body.decision === "approve" ? "approve" : "deny", body.headless === true));
        coordinator.notifyChanged();
        return { status: 200, body: request, entry: { type: "team-decide", user: who.user, id, status: request.status } };
      }
      case "/v1/team/reply": {
        const who = asWho(body);
        const { id } = requireStrings(body, ["id"]);
        const request = teamCall(() => team.reply(who, id, body.text as string));
        coordinator.notifyChanged();
        return { status: 200, body: request, entry: { type: "team-reply", user: who.user, id, chars: request.reply?.length } };
      }
      case "/v1/team/requests":
        return { status: 200, body: { requests: team.open(asWho(body)) } };
      // Never log a token: the entries carry the name only.
      case "/v1/members/invite": {
        const invited = teamCall(() => members.invite(body.name, body.github));
        return { status: 200, body: invited, entry: { type: "member-invite", name: invited.name, github: invited.github } };
      }
      case "/v1/members/remove": {
        const removed = members.remove(body.name);
        if (removed && team.revoke(String(body.name)) > 0) coordinator.notifyChanged();
        return { status: 200, body: { removed }, entry: { type: "member-remove", name: body.name, removed } };
      }
      case "/v1/members/list":
        return { status: 200, body: { members: members.names() } };
      default:
        throw new HttpError(404, "not found");
    }
  }

  const sweep = setInterval(() => coordinator.sweep(), options.sweepIntervalMs ?? 5_000);
  sweep.unref();

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host ?? "127.0.0.1", resolve);
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://${options.host ?? "127.0.0.1"}:${port}`,
    coordinator,
    lastActivity: () => lastActivity,
    close: () =>
      new Promise((resolve) => {
        clearInterval(sweep);
        clearTimeout(broadcastTimer);
        stopBroadcast();
        for (const stream of streams) stream.destroy(); // upgraded sockets are no longer the HTTP server's
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/**
 * The tasks viewers get: every active one and each person's latest finished ones. All finished tasks (up to 1,000) made the
 * snapshot grow with every prompt, and it goes to every viewer on every change (#261). Team context reads the full list.
 * shortcut: `lanes pr --task <id>` of an older finished task falls back to matching its text; add a task lookup route if that bites.
 */
export function recentTasks(tasks: Task[], donePerUser = DONE_TASKS_SHOWN): Task[] {
  const done = new Map<string, number>();
  const kept: Task[] = [];
  for (let i = tasks.length - 1; i >= 0; i--) {
    const t = tasks[i];
    if (t.status === "done") {
      const n = done.get(t.user) ?? 0;
      if (n >= donePerUser) continue;
      done.set(t.user, n + 1);
    }
    kept.push(t);
  }
  return kept.reverse();
}

function send(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new HttpError(413, "body too large");
    chunks.push(chunk as Buffer);
  }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (typeof parsed !== "object" || parsed === null) throw new Error();
    return parsed;
  } catch {
    throw new HttpError(400, "body must be a JSON object");
  }
}

/**
 * Only callers with the token, addressing the server by a name it expects. The token stops other LAN hosts and
 * web pages (CSRF); the Host check stops DNS rebinding; JSON-only POSTs (checked by the caller) need a CORS preflight.
 */
function checkCaller(req: http.IncomingMessage, options: ServerOptions, members: Members, queryToken?: string): string | undefined {
  const host = bareHost((req.headers.host ?? "").replace(/:\d+$/, "")).replace(/\.$/, ""); // "name." is the same name
  if (!allowedHostNames(options).includes(host)) {
    throw new HttpError(403, "unexpected Host header");
  }
  const auth = req.headers.authorization ?? (queryToken === undefined ? "" : `Bearer ${queryToken}`);
  // A member token identifies its member even on a server without an admin token (in-process tests).
  const member = auth.startsWith("Bearer ") ? members.find(auth.slice(7)) : undefined;
  if (member !== undefined || options.token === undefined) return member;
  const given = Buffer.from(auth);
  const expected = Buffer.from(`Bearer ${options.token}`);
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) throw new HttpError(401, "missing or wrong token");
  return undefined;
}

/**
 * A connection from this machine: loopback, or one of the machine's own addresses (the CLI may reach its own server by
 * its LAN address, and a TCP peer cannot fake its source address).
 */
export function fromThisMachine(address: string | undefined): boolean {
  const a = (address ?? "").replace(/^::ffff:/i, "").toLowerCase();
  if (a === "::1" || /^127\./.test(a)) return true;
  return a !== "" && Object.values(os.networkInterfaces()).some((list) => (list ?? []).some((i) => i.address.toLowerCase() === a));
}

/** The Host part of checkCaller alone, for the app's static files. */
function hostAllowed(req: http.IncomingMessage, options: ServerOptions): boolean {
  return allowedHostNames(options).includes(bareHost((req.headers.host ?? "").replace(/:\d+$/, "")).replace(/\.$/, ""));
}

/** "http://host:port" gives "host"; anything unparseable (including "null") gives "" and so matches nothing. */
function originHost(origin: string): string {
  try {
    return new URL(origin).hostname;
  } catch {
    return "";
  }
}

/** Host names this server answers to: loopback, its bind address, and (beyond loopback) its own addresses and name (#86). */
function allowedHostNames(options: ServerOptions): string[] {
  const bind = bareHost(options.host ?? "127.0.0.1");
  const names = [...LOOPBACK, bind, ...(options.allowedHosts ?? []).map(bareHost)];
  if (!LOOPBACK.includes(bind)) {
    // Read per request, not once: a laptop changes addresses while the server runs.
    for (const list of Object.values(os.networkInterfaces())) for (const i of list ?? []) names.push(bareHost(i.address));
    // The machine name, its mDNS name (the usual way on macOS, Linux and Windows 10+) and its Windows DNS domain (#112).
    const name = os.hostname().toLowerCase();
    names.push(name, `${name}.local`);
    if (process.env.USERDNSDOMAIN) names.push(`${name}.${process.env.USERDNSDOMAIN.toLowerCase()}`);
  }
  return names;
}

function requireStrings<K extends string>(body: Record<string, unknown>, keys: K[]): Record<K, string> {
  for (const key of keys) {
    const value = body[key];
    if (typeof value !== "string" || value === "" || value.length > MAX_STRING) throw new HttpError(400, `missing or invalid field: ${key}`);
  }
  return body as Record<K, string>;
}

function asPaths(value: unknown, max = MAX_PATHS): string[] {
  if (!Array.isArray(value) || value.length > max || !value.every((p) => typeof p === "string" && p !== "" && p.length <= MAX_STRING)) {
    throw new HttpError(400, `paths must be an array of at most ${max} strings`);
  }
  return value;
}

/** A [first, last] line range: whole numbers, first ≤ last. */
function asRange(value: unknown): LineRange {
  if (!Array.isArray(value) || value.length !== 2 || !value.every((n) => Number.isSafeInteger(n) && n >= 1) || value[0] > value[1]) {
    throw new HttpError(400, "a range must be [first, last] line numbers");
  }
  return [value[0], value[1]];
}

/** path → ranges, for at most MAX_PATHS paths and MAX_RANGES ranges each. A null-prototype object: paths are keys. */
function asRangeMap(value: unknown): Record<string, LineRange[]> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new HttpError(400, "ranges must be an object");
  const entries = Object.entries(value);
  if (entries.length > MAX_PATHS) throw new HttpError(400, `ranges may name at most ${MAX_PATHS} files`);
  const out: Record<string, LineRange[]> = Object.create(null);
  for (const [path, list] of entries) {
    asPaths([path], 1);
    if (!Array.isArray(list) || list.length > MAX_RANGES) throw new HttpError(400, `ranges must be arrays of at most ${MAX_RANGES} ranges`);
    out[path] = mergeRanges(list.map(asRange));
  }
  return out;
}

function asCheck(body: Record<string, unknown>): CheckRequest {
  requireStrings(body, ["user", "sessionId", "repo", "label", "tool"]);
  asPaths(body.paths);
  return body as unknown as CheckRequest;
}

function asWho(body: Record<string, unknown>): Who {
  return requireStrings(body, ["user", "sessionId", "repo"]);
}

/** Team rule violations (empty text, wrong receiver, …) are the caller's mistake: 400, with the reason. */
function teamCall<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    throw new HttpError(400, (err as Error).message);
  }
}

function asSession(body: Record<string, unknown>): SessionRequest {
  requireStrings(body, ["user", "sessionId", "repo", "label", "event"]);
  if (!["start", "stop", "end"].includes(body.event as string)) throw new HttpError(400, "invalid event");
  return body as unknown as SessionRequest;
}
