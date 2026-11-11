// `lanes report` and `lanes hosted`: what the local ledger says, in words the user can read and copy.
// The report holds counts and times only: never a file path, a prompt, a task title, a person's name or a repository name
// (repositories appear as a short hash). Nothing is sent anywhere; the user decides whether to paste or email it.
import { readLedger, summarize, type LedgerSummary } from "@lanes/core/ledger.ts";
import { loadConfig, tokenFor } from "@lanes/core/local.ts";
import type { Snapshot } from "@lanes/core/types.ts";

export interface Report {
  generatedAt: string;
  periodDays: number;
  /** From ~/.lanes/ledger.jsonl on this machine. */
  local: LedgerSummary;
  /** From the server's current state; null when it did not answer. Counts only. */
  server: { people: number; agents: number; repositories: number; uncoordinatedThisWeek: number } | null;
}

export async function collectReport(opts: { days?: number; server?: string; token?: string; now?: number } = {}): Promise<Report> {
  const now = opts.now ?? Date.now();
  const days = opts.days ?? 28;
  const config = loadConfig();
  const url = (opts.server ?? config.serverUrl).replace(/\/+$/, "");
  const bearer = opts.token ?? (opts.server ? tokenFor({ ...config, serverUrl: url, token: undefined }) : tokenFor(config));
  let server: Report["server"] = null;
  try {
    const res = await fetch(url + "/v1/state", { headers: bearer ? { authorization: `Bearer ${bearer}` } : {}, signal: AbortSignal.timeout(2000) });
    if (res.ok) {
      const s = (await res.json()) as Snapshot;
      server = {
        people: new Set(s.agents.map((a) => a.user)).size,
        agents: s.agents.length,
        repositories: new Set(s.agents.map((a) => a.repo)).size,
        uncoordinatedThisWeek: Object.values(s.uncoordinated ?? {}).reduce((sum, n) => sum + n, 0),
      };
    }
  } catch {
    // offline: the local ledger still tells the story
  }
  return { generatedAt: new Date(now).toISOString(), periodDays: days, local: summarize(readLedger(), now, days), server };
}

const pct = (x: number | null) => (x === null ? "n/a" : `${(x * 100).toFixed(1)}%`);
const secs = (ms: number | null) => (ms === null ? "n/a" : `${(ms / 1000).toFixed(1)} s`);

export function formatReport(r: Report): string {
  const l = r.local;
  const lines = [
    `Lanes report, last ${r.periodDays} days (generated ${r.generatedAt})`,
    "Counts and times only: no file paths, prompts, task titles or names. Nothing was sent anywhere.",
    "",
    `Edits seen on this machine:            ${l.edits}`,
    `  coordinated:                         ${l.coordinated} (${pct(l.coordinatedShare)} of edits: an estimate of how often the server was there)`,
    `  went ahead uncoordinated:            ${l.uncoordinated} (the server was down, unreachable or too slow)`,
    `  weeks with at least one such edit:   ${l.downtimeWeeks}`,
    `Collisions handled (waited in queue):  ${l.queued}`,
    `Queue wait, 95th percentile:           ${secs(l.queueWaitP95Ms)}`,
  ];
  if (l.repos.length > 0) {
    lines.push("", "Per repository (hash, not a name):");
    for (const p of l.repos) lines.push(`  ${p.repo}: ${p.edits} edits, ${pct(p.coordinatedShare)} coordinated, ${p.uncoordinated} uncoordinated`);
  }
  lines.push("");
  if (r.server) {
    lines.push(`Served right now by the server: ${r.server.people} ${r.server.people === 1 ? "person" : "people"}, ${r.server.agents} ${r.server.agents === 1 ? "agent" : "agents"}, ${r.server.repositories} ${r.server.repositories === 1 ? "repository" : "repositories"}`);
    lines.push(`Uncoordinated edits the server was told about this week: ${r.server.uncoordinatedThisWeek}`);
  } else {
    lines.push("Server: did not answer (the local counts above do not need it).");
  }
  if (l.edits === 0) lines.push("", "No edits recorded yet. The ledger fills as agents edit files in a repository set up with Lanes.");
  return lines.join("\n");
}

/** A file the user may fill in and email if they want to. Every question is optional; nothing is sent from here. */
export function feedbackFile(r: Report): string {
  return [
    formatReport(r),
    "",
    "----------------------------------------------------------------------",
    "Optional notes. Skip anything. You are not obliged to send this file.",
    "If you do email it, we read it and do not reply asking for more.",
    "",
    "What got in your way?",
    "",
    "",
    "What would make a hosted Lanes server worth paying for to you (if anything)?",
    "",
    "",
    "Anything else?",
    "",
    "",
  ].join("\n");
}

// shortcut: the placeholder address of the site, until the real domain exists (Phase 4 issue 4.F4, #157); change it together with site/*.html.
const WAITLIST_ADDRESS = "hello@trylanes.app";

/** The waitlist email for the hosted server. A waitlist, not a purchase: nothing is charged and nothing is sent from here. */
export function hostedWaitlist(): string {
  const subject = encodeURIComponent("Lanes hosted server waitlist");
  const body = encodeURIComponent("Please add me to the waitlist for the hosted Lanes server. I understand this is not a purchase.");
  return [
    "Hosted Lanes server: waitlist",
    "The hosted server is planned and does not exist yet. This is a waitlist, not a purchase: nothing is charged, nothing is promised.",
    "Nothing is sent from here. To join, send an email yourself:",
    `  mailto:${WAITLIST_ADDRESS}?subject=${subject}&body=${body}`,
  ].join("\n");
}
