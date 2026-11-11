// Personal member tokens (ADR-0030). Only a SHA-256 hash of each token is kept, in a private file (0600) written
// atomically: a lost token is replaced, never recovered. A seat can be bound to a GitHub account (ADR-0031).
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import { clean } from "@lanes/team/team.ts";

export interface Member {
  name: string;
  /** No hash: a GitHub seat nobody has claimed yet (`lanes invite <name> --github <login>`). */
  hash?: string;
  createdAt: number;
  /** Lowercased GitHub login the seat was invited for. */
  github?: string;
  /** GitHub's numeric user id, bound at the first sign-in, so a renamed or recycled login cannot take the seat. */
  githubId?: number;
}

const sha256 = (token: string) => crypto.createHash("sha256").update(token).digest("hex");
const newToken = () => `lanes_m_${crypto.randomBytes(32).toString("base64url")}`;
/** GitHub's login rule: letters, digits and single hyphens, at most 39 characters. */
export const GITHUB_LOGIN = /^[a-z\d](?:[a-z\d]|-(?=[a-z\d])){0,38}$/i;

export class Members {
  private list: Member[] = [];
  private file?: string;

  /** No file: kept in memory only (in-process tests). A file that exists but cannot be read stops the server rather than be overwritten. */
  constructor(file?: string) {
    this.file = file;
    if (!file) return;
    try {
      const list = JSON.parse(fs.readFileSync(file, "utf8")).members;
      // `{}` or a hand-edited entry used to start a server that then failed every request, leases included (ADR-0019).
      if (!Array.isArray(list) || !list.every((m) => typeof m?.name === "string" && m.name && (m.hash === undefined || typeof m.hash === "string"))) throw new Error();
      this.list = list;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw new Error(`${file} is not a valid members file: fix or delete it`);
    }
  }

  get size(): number {
    return this.list.length;
  }

  /** The member this token belongs to. Hashes are compared in constant time, so timing reveals nothing about any token. */
  find(token: string): string | undefined {
    const given = Buffer.from(sha256(token));
    return this.list.find((m) => m.hash !== undefined && crypto.timingSafeEqual(given, Buffer.from(m.hash)))?.name;
  }

  /**
   * A new token for `raw`; an existing name (any case) gets a new token and the old one stops working.
   * With `github`: the seat is bound to that login and gets no token here (the teammate signs in); an existing token is kept.
   */
  invite(raw: unknown, github?: unknown): { name: string; token?: string; github?: string } {
    // The same characters the team layer shows for a name, so it is also safe inside the printed `lanes join` command.
    const name = clean(raw, 40).replace(/[^\p{L}\p{N} ._@'-]/gu, "").trim();
    if (!name) throw new Error("a member needs a name");
    const same = (m: Member) => m.name.toLowerCase() === name.toLowerCase();
    const old = this.list.find(same);
    let seat: Member;
    let token: string | undefined;
    if (github === undefined) {
      token = newToken();
      seat = { ...old, name, hash: sha256(token), createdAt: Date.now() };
    } else {
      if (typeof github !== "string" || !GITHUB_LOGIN.test(github.replace(/^@/, ""))) throw new Error("not a GitHub login");
      const login = github.replace(/^@/, "").toLowerCase();
      const taken = this.list.find((m) => !same(m) && m.github === login);
      if (taken) throw new Error(`@${login} is already invited as ${taken.name}`);
      // The same login keeps its bound id; a new login is bound again at its first sign-in.
      seat = { name, hash: old?.hash, createdAt: old?.createdAt ?? Date.now(), github: login, githubId: old?.github === login ? old.githubId : undefined };
    }
    this.list = [...this.list.filter((m) => !same(m)), seat];
    this.save();
    return { name, token, github: seat.github };
  }

  /**
   * A fresh token for the seat of this GitHub account: the one bound to its id, else the one invited for its login and not
   * bound yet (which is then bound). Undefined when the account is not on the team.
   */
  claim(login: string, id: number): { name: string; token: string } | undefined {
    const lower = login.toLowerCase();
    const seat = this.list.find((m) => m.githubId === id) ?? this.list.find((m) => m.github === lower && m.githubId === undefined);
    if (!seat) return undefined;
    const token = newToken();
    Object.assign(seat, { hash: sha256(token), github: lower, githubId: id });
    this.save();
    return { name: seat.name, token };
  }

  remove(name: unknown): boolean {
    const before = this.list.length;
    this.list = this.list.filter((m) => typeof name !== "string" || m.name.toLowerCase() !== name.trim().toLowerCase());
    this.save();
    return this.list.length < before;
  }

  names(): { name: string; createdAt: number; github?: string }[] {
    return this.list.map(({ name, createdAt, github }) => ({ name, createdAt, github }));
  }

  private save(): void {
    if (!this.file) return;
    const tmp = `${this.file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}`;
    fs.writeFileSync(tmp, JSON.stringify({ members: this.list }, null, 2) + "\n", { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }
}
