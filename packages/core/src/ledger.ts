// The local ledger: what coordination did for the edits on this machine, kept only here (docs/strategy/pricing-validation.md).
// One JSON line per edit: {ts, repo, kind, ms}. Never a path, file content, prompt or name; the repository is a short hash.
// Nothing leaves the machine: `lanes report` shows it and the user decides whether to send anything.
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { privateDir } from "./local.ts";

/** `failopen`: the server was down or too slow and the edit went ahead uncoordinated. `queued`: the edit waited behind another agent. `ok`: coordinated with no wait. */
export type LedgerKind = "failopen" | "queued" | "ok";
export interface LedgerEntry {
  ts: number;
  repo: string;
  kind: LedgerKind;
  ms: number;
}

/** When the file is bigger than this it is moved to ledger.jsonl.1 (replacing the old one): at most about twice this on disk. */
export const LEDGER_MAX_BYTES = Number(process.env.LANES_LEDGER_MAX_BYTES ?? 256 * 1024);
export const WEEK_MS = 7 * 24 * 3_600_000;

const file = () => path.join(privateDir(), "ledger.jsonl");
/** Set while some failopen entries may not have reached the server yet, so the hook skips reading the ledger on every edit. */
const pendingFlag = () => path.join(privateDir(), "ledger.pending");
const watermarkFile = () => path.join(privateDir("cache"), "ledger-reported.json");

/** A short hash: lets a report tell repositories apart without naming them. */
export const repoKey = (repoId: string): string => crypto.createHash("sha1").update(repoId).digest("hex").slice(0, 8);

/** Appends one entry. Best effort: coordination bookkeeping must never fail an edit. */
export function appendLedger(repoId: string, kind: LedgerKind, ms: number, now = Date.now()): void {
  try {
    const f = file();
    try {
      if (fs.statSync(f).size > LEDGER_MAX_BYTES) fs.renameSync(f, `${f}.1`);
    } catch {
      // no ledger yet
    }
    const entry: LedgerEntry = { ts: now, repo: repoKey(repoId), kind, ms: Math.max(0, Math.round(ms)) };
    fs.appendFileSync(f, JSON.stringify(entry) + "\n", { mode: 0o600 });
    if (kind === "failopen") fs.writeFileSync(pendingFlag(), "", { mode: 0o600 });
  } catch {
    // shortcut: a full disk or a locked file loses this one line; the edit is unaffected
  }
}

/** Every readable entry, oldest first. Damaged lines are skipped. */
export function readLedger(): LedgerEntry[] {
  const out: LedgerEntry[] = [];
  for (const f of [`${file()}.1`, file()]) {
    let text = "";
    try {
      text = fs.readFileSync(f, "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      try {
        const e = JSON.parse(line) as LedgerEntry;
        if (typeof e.ts === "number" && typeof e.repo === "string" && typeof e.ms === "number" && (e.kind === "failopen" || e.kind === "queued" || e.kind === "ok")) out.push(e);
      } catch {
        // blank or damaged line
      }
    }
  }
  return out;
}

/**
 * The failopen entries of this repository from the last week that the server has not been told about yet, and marks them
 * told. The hook calls it after a successful contact (the next time the server answers), so a down server is reported once it is back.
 */
export function takeUnreported(repoId: string, now = Date.now()): number {
  try {
    if (!fs.existsSync(pendingFlag())) return 0;
    let marks: Record<string, number> = {};
    try {
      marks = JSON.parse(fs.readFileSync(watermarkFile(), "utf8"));
    } catch {
      // none yet
    }
    const key = repoKey(repoId);
    const failed = readLedger().filter((e) => e.kind === "failopen");
    const count = failed.filter((e) => e.repo === key && e.ts > (marks[key] ?? 0) && e.ts > now - WEEK_MS).length;
    marks[key] = now;
    fs.writeFileSync(watermarkFile(), JSON.stringify(marks), { mode: 0o600 });
    // The flag stays while another repository still has entries nobody reported.
    if (!failed.some((e) => e.repo !== key && e.ts > (marks[e.repo] ?? 0))) fs.rmSync(pendingFlag(), { force: true });
    return count;
  } catch {
    return 0;
  }
}

export interface RepoSummary {
  /** repoKey, a hash. */
  repo: string;
  edits: number;
  uncoordinated: number;
  /** Share of edits that were coordinated, 0 to 1. An estimate of how often the server was there. */
  coordinatedShare: number;
}
export interface LedgerSummary {
  days: number;
  edits: number;
  coordinated: number;
  uncoordinated: number;
  queued: number;
  coordinatedShare: number | null;
  queueWaitP95Ms: number | null;
  /** Calendar weeks (7-day buckets back from now) with at least one uncoordinated edit. */
  downtimeWeeks: number;
  repos: RepoSummary[];
}

/** The nearest-rank 95th percentile. */
export function p95(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)];
}

export function summarize(entries: LedgerEntry[], now = Date.now(), days = 28): LedgerSummary {
  const from = now - days * 24 * 3_600_000;
  const inWindow = entries.filter((e) => e.ts > from && e.ts <= now + 60_000);
  const uncoordinated = inWindow.filter((e) => e.kind === "failopen").length;
  const queued = inWindow.filter((e) => e.kind === "queued");
  const per = new Map<string, { edits: number; bad: number }>();
  for (const e of inWindow) {
    const r = per.get(e.repo) ?? { edits: 0, bad: 0 };
    r.edits++;
    if (e.kind === "failopen") r.bad++;
    per.set(e.repo, r);
  }
  const weeks = new Set(inWindow.filter((e) => e.kind === "failopen").map((e) => Math.floor((now - e.ts) / WEEK_MS)));
  return {
    days,
    edits: inWindow.length,
    coordinated: inWindow.length - uncoordinated,
    uncoordinated,
    queued: queued.length,
    coordinatedShare: inWindow.length ? (inWindow.length - uncoordinated) / inWindow.length : null,
    queueWaitP95Ms: p95(queued.map((e) => e.ms)),
    downtimeWeeks: weeks.size,
    repos: [...per].map(([repo, r]) => ({ repo, edits: r.edits, uncoordinated: r.bad, coordinatedShare: (r.edits - r.bad) / r.edits })),
  };
}
