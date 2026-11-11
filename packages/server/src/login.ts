// Sign in with GitHub (ADR-0031): the server runs GitHub's device flow, so neither the CLI nor the browser app needs a
// client secret or a redirect URL. The device code and the access token stay here; the access token is used once to read
// the profile and dropped, never stored or logged. GitHub's answers are untrusted input.
import * as crypto from "node:crypto";
import { GITHUB_LOGIN, type Members } from "./members.ts";

export interface GitHubLoginOptions {
  clientId?: string;
  web?: string;
  api?: string;
}

interface Pending {
  deviceCode: string;
  remote: string;
  expiresAt: number;
  interval: number;
  nextPollAt: number;
  busy: boolean;
}

type Reply = { status: number; body: Record<string, unknown>; entry?: Record<string, unknown> };

const MAX_PENDING = 20;
const MAX_PENDING_PER_ADDRESS = 5;
const NOT_SET_UP = { status: 501, body: { error: "GitHub sign-in isn't set up on this server" } };
const isText = (v: unknown, max = 512): v is string => typeof v === "string" && v !== "" && v.length <= max;
const isSeconds = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v > 0 && v <= 3600;

export class GitHubLogin {
  private pending = new Map<string, Pending>();
  private web: string;
  private api: string;
  private options: GitHubLoginOptions;
  private members: Members;

  constructor(options: GitHubLoginOptions, members: Members) {
    this.options = options;
    this.members = members;
    this.web = (options.web ?? "https://github.com").replace(/\/+$/, "");
    this.api = (options.api ?? "https://api.github.com").replace(/\/+$/, "");
  }

  get enabled(): boolean {
    return Boolean(this.options.clientId);
  }

  async start(remote: string): Promise<Reply> {
    if (!this.options.clientId) return NOT_SET_UP;
    const now = Date.now();
    for (const [id, p] of this.pending) if (p.expiresAt <= now) this.pending.delete(id);
    // Each pending login costs GitHub calls: a cap overall and per address keeps an unauthenticated caller from piling them up.
    if (this.pending.size >= MAX_PENDING || [...this.pending.values()].filter((p) => p.remote === remote).length >= MAX_PENDING_PER_ADDRESS) {
      return { status: 429, body: { error: "too many sign-ins in progress: finish one or wait a few minutes" } };
    }
    const data = await this.github(`${this.web}/login/device/code`, { client_id: this.options.clientId, scope: "read:user" });
    if (!data) return { status: 502, body: { error: "GitHub did not answer: try again" } };
    const { device_code, user_code, verification_uri, interval, expires_in } = data;
    if (!isText(device_code) || !isText(user_code, 32) || !isText(verification_uri) || !/^https:\/\//.test(verification_uri) || !isSeconds(expires_in)) {
      return { status: 502, body: { error: isText(data.error_description) ? `GitHub refused: ${data.error_description}` : "GitHub sent an unexpected answer" } };
    }
    const loginId = crypto.randomBytes(16).toString("base64url");
    const seconds = isSeconds(interval) ? interval : 5;
    this.pending.set(loginId, { deviceCode: device_code, remote, expiresAt: now + expires_in * 1000, interval: seconds, nextPollAt: now, busy: false });
    return { status: 200, body: { loginId, userCode: user_code, verificationUri: verification_uri, interval: seconds, expiresIn: expires_in }, entry: { type: "login-start" } };
  }

  async poll(loginId: unknown): Promise<Reply> {
    if (!this.options.clientId) return NOT_SET_UP;
    const p = typeof loginId === "string" ? this.pending.get(loginId) : undefined;
    if (!p) return { status: 200, body: { status: "denied", error: "this sign-in is unknown or already used: start again" } };
    const now = Date.now();
    if (p.expiresAt <= now) {
      this.pending.delete(loginId as string);
      return { status: 200, body: { status: "denied", error: "the code expired: sign in again" } };
    }
    // Never faster than GitHub's interval, however fast the client polls.
    if (p.busy || now < p.nextPollAt) return { status: 200, body: { status: "pending", interval: p.interval } };
    p.busy = true;
    p.nextPollAt = now + p.interval * 1000;
    const data = await this.github(`${this.web}/login/oauth/access_token`, { client_id: this.options.clientId, device_code: p.deviceCode, grant_type: "urn:ietf:params:oauth:grant-type:device_code" });
    p.busy = false;
    if (!data) return { status: 502, body: { error: "GitHub did not answer: try again" } };
    if (data.error === "authorization_pending") return { status: 200, body: { status: "pending", interval: p.interval } };
    if (data.error === "slow_down") {
      p.interval = isSeconds(data.interval) ? data.interval : p.interval + 5;
      p.nextPollAt = Date.now() + p.interval * 1000;
      return { status: 200, body: { status: "pending", interval: p.interval } };
    }
    this.pending.delete(loginId as string); // single use from here on, whatever the outcome
    if (!isText(data.access_token, 4096)) {
      const error = data.error === "access_denied" ? "the sign-in was cancelled on GitHub" : data.error === "expired_token" ? "the code expired: sign in again" : `GitHub refused the sign-in${isText(data.error, 100) ? ` (${data.error})` : ""}`;
      return { status: 200, body: { status: "denied", error } };
    }
    const user = await this.profile(data.access_token);
    if (!user) return { status: 502, body: { error: "could not read your GitHub profile: sign in again" } };
    const seat = this.members.claim(user.login, user.id);
    if (!seat) {
      return { status: 200, body: { status: "denied", error: `${user.login} isn't on this team: ask the admin to run lanes invite <name> --github ${user.login}` }, entry: { type: "login-denied", github: user.login } };
    }
    return { status: 200, body: { status: "done", ...seat }, entry: { type: "login-done", name: seat.name, github: user.login } };
  }

  /** POST to GitHub with form parameters; the JSON object it answers, or undefined when it cannot be reached or read. */
  private async github(url: string, params: Record<string, string>): Promise<Record<string, unknown> | undefined> {
    try {
      const res = await fetch(url, { method: "POST", headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded", "user-agent": "lanes" }, body: new URLSearchParams(params), signal: AbortSignal.timeout(10_000) });
      const data: unknown = await res.json();
      return typeof data === "object" && data !== null && !Array.isArray(data) ? (data as Record<string, unknown>) : undefined;
    } catch {
      return undefined;
    }
  }

  private async profile(token: string): Promise<{ login: string; id: number } | undefined> {
    try {
      const res = await fetch(`${this.api}/user`, { headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "user-agent": "lanes" }, signal: AbortSignal.timeout(10_000) });
      if (!res.ok) return undefined;
      const data = (await res.json()) as { login?: unknown; id?: unknown } | null;
      if (typeof data?.login !== "string" || !GITHUB_LOGIN.test(data.login) || !Number.isSafeInteger(data.id) || (data.id as number) <= 0) return undefined;
      return { login: data.login, id: data.id as number };
    } catch {
      return undefined;
    }
  }
}
