#!/usr/bin/env node
// Builds the public Lanes tree from the private worktree.
// Usage: node scripts/sync-oss.mjs [source] [staging]
//   source  default C:\Users\<you>\Desktop\lanes-mp (the private worktree, only read)
//   staging default the folder two levels up from this script
// Idempotent: everything in staging is deleted first, except the KEEP paths below.
// Exits 1 (and prints every hit) when the secret and private-data scan finds anything.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const SELF = fileURLToPath(import.meta.url);
const SRC = path.resolve(process.argv[2] ?? path.join(os.homedir(), "Desktop", "lanes-mp"));
const DST = path.resolve(process.argv[3] ?? path.join(path.dirname(SELF), ".."));
const REPO_URL = "https://github.com/mfmatozza/lanes";

// Paths in staging that are written by hand and survive a sync.
const KEEP = [".git", "README.md", "LICENSE", "CONTRIBUTING.md", "SECURITY.md", "CODE_OF_CONDUCT.md", ".github", "scripts/sync-oss.mjs",
  "docs/README.md", // the public docs index, written by hand
];

// [source path, staging path]. A directory is copied recursively, minus EXCLUDE.
const ALLOW = [
  ["packages", "packages"],
  ["scripts/build.mjs", "scripts/build.mjs"],
  ["scripts/bench-hook.ts", "scripts/bench-hook.ts"],
  ["scripts/runner/run.ts", "scripts/runner/run.ts"],
  ["scripts/runner/README.md", "scripts/runner/README.md"],
  ["scripts/e2e", "scripts/e2e"],
  ["package.json", "package.json"],
  ["package-lock.json", "package-lock.json"],
  ["tsconfig.json", "tsconfig.json"],
  [".gitignore", ".gitignore"],
  [".gitattributes", ".gitattributes"], // eol=lf: tests compare file contents byte for byte on Windows too
  [".github/workflows/ci.yml", ".github/workflows/ci.yml"],
  // Docs a user or contributor needs, nothing else: no strategy, plans, process notes or the 30 raw ADRs
  // (docs/design.md summarises the technical decisions; links to an ADR are pointed at its entry there).
  ["docs/cli.md", "docs/cli.md"],
  ["docs/mcp.md", "docs/mcp.md"],
  ["docs/design.md", "docs/design.md"],
  ["docs/architecture", "docs/architecture"],
  ["docs/benchmark", "docs/benchmark"],
  ["spike/testbed", "spike/testbed"], // the runner's scenarios and template repository (scripts/runner/run.ts)
  ["site/assets/shots/lanes-team-dark.webp", "docs/images/lanes-team-dark.webp"],
  ["site/assets/shots/app-dark.webp", "docs/images/app-dark.webp"],
  ["site/assets/shots/app-lanes-dark.webp", "docs/images/app-lanes-dark.webp"],
  ["site/assets/shots/app-light.webp", "docs/images/app-light.webp"],
];

// Relative source paths (forward slashes) that never go public.
const EXCLUDE_PREFIX = ["upload/", "site/", "spike/", "scripts/vscode-tryout/", "docs/strategy/", "docs/plans/",
  "docs/research/demand-evidence.md", "docs/research/hosting-costs.md",
  "docs/engineering/beta-signup.md", // the site's beta sign-up API: the site stays private
  "docs/README.md", // replaced by the hand-written public index in staging (KEEP)
];
const EXCLUDE_DIR = new Set(["node_modules", "dist", "coverage", ".lanes", "results"]);
const EXCLUDE_NAME = [/\.vsix$/i, /\.secret/i, /^\.env/i, /^token$/i, /^ledger\.json$/i, /pricing|investor|founder|legal/i];

// An ALLOW entry under an excluded prefix (spike/testbed, the screenshots under site/) is copied anyway:
// below it only the name and directory rules apply.
const underPrefix = (rel) => EXCLUDE_PREFIX.some((p) => rel === p.replace(/\/$/, "") || rel.startsWith(p));
const FORCED = ALLOW.map(([s]) => s).filter(underPrefix);
function excluded(rel, isDir) {
  if (underPrefix(rel) && !FORCED.some((f) => rel === f || rel.startsWith(f + "/"))) return true;
  const name = path.posix.basename(rel);
  if (isDir) return EXCLUDE_DIR.has(name);
  return EXCLUDE_NAME.some((re) => re.test(name));
}

// --- secret and private-data scan ---------------------------------------------------------------
// Token patterns need a body after the prefix: the bare prefixes appear in source code that issues and checks tokens.
const PATTERNS = [
  ["lanes member token", /lanes_m_[A-Za-z0-9_-]{8,}/],
  ["GitHub token", /\bgh[pu]_[A-Za-z0-9]{16,}/],
  ["sk- key", /\bsk-[A-Za-z0-9_-]{16,}/],
  ["Resend key", /\bre_[A-Za-z0-9_]{20,}/],
  ["Bearer token", /Bearer [A-Za-z0-9]{20,}/],
  ["Windows user name", /mfmat(?!ozza)/i], // "mfmatozza" is the public GitHub owner of the repository
  ["user folder", /C:[\\/]+Users/i],
  ["private name", /buildinterest/i],
];
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
const FAKE_EMAIL = [
  /^noreply@anthropic\.com$/i,
  /[@.]example\.(com|org|net)$/i, /\.(test|invalid|example|localhost|local|internal)$/i, // reserved names (RFC 2606, 6761)
  /^(git|tok|token)@github\.com$/i, // userinfo in git remote URLs (SSH form and token form) in repo.ts and its tests
  /^t@e\.com$/i, // throwaway committer address in tests and e2e scripts
  /^(ana|bea|carl|dan)@/i, // the demo teammates used in tests and docs
  /@acme\.dev$/i,
  /@lanes\.dev$/i, // committer address of the runner's and tests' throwaway repositories
  /@users\.noreply\.github\.com$/i,
];
// Files allowed to contain a given hit: [path, label, reason]. Keep this list short and explain every entry.
const SCAN_EXCEPTIONS = [
  // Fake secrets on purpose: these tests check that the hook redacts tokens before anything leaves the machine.
  ["packages/hook/test/hook.test.ts", "GitHub token", "redaction test fixture"],
  ["packages/hook/test/hook.test.ts", "sk- key", "redaction test fixture"],
  ["packages/hook/test/redact.test.ts", "GitHub token", "redaction test fixture"],
  ["packages/hook/test/redact.test.ts", "sk- key", "redaction test fixture"],
  ["packages/hook/test/redact-lists.test.ts", "GitHub token", "redaction test fixture"],
  ["packages/hook/test/redact-lists.test.ts", "sk- key", "redaction test fixture"],
  // Planted fake secrets (ghp_...FAKE..., sk_live_FAKE...) in the leak scenarios: the runner checks they never reach
  // lanes/main or the server log.
  ["spike/testbed/scenarios.json", "GitHub token", "planted fake secret for leak scenario S1"],
  // A made-up Windows path (after REWRITES below) in a test of how long task titles are shortened.
  ["packages/hook/test/redact-lists.test.ts", "user folder", "fictional path fixture"],
  // The public contact address that `lanes report` prints for the hosted-server waitlist.
  ["packages/cli/src/report.ts", "email", "public waitlist address on the project's site"],
];
// Text rewrites in staging after the copy, before the scan: [path, from, to, reason].
const REWRITES = [
  ["docs/architecture/agent-integration.md", " ([pricing validation](../strategy/pricing-validation.md), [ADR-0027](../decisions/0027-behavioural-pricing-signals.md))", "", "pricing research is private"],
  ["docs/benchmark/method.md", " (ADR-0012)", "", "the founder ADR is private"],
  ["packages/extension/README.md", "private beta", "beta", "the beta is public now"],
  ["packages/hook/test/redact-lists.test.ts", "C:/Users/mfmat/", "C:/Users/alice/", "real user name in a path fixture; same length, so the test is unchanged"],
];

const TEXT_EXT = /\.(m?[jt]sx?|c[jt]s|json|md|ya?ml|txt|html?|css|svg|sh|ps1|gitignore|gitattributes)$|^[^.]+$/i;

function walk(dir, base = dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== ".git") walk(p, base, out); } else out.push(path.relative(base, p).split(path.sep).join("/"));
  }
  return out;
}

function clean() {
  if (!fs.existsSync(DST)) { fs.mkdirSync(DST, { recursive: true }); return; }
  const keep = (rel) => KEEP.some((k) => rel === k || rel.startsWith(k + "/"));
  const holdsKeep = (rel) => KEEP.some((k) => k.startsWith(rel + "/"));
  (function rm(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, e.name);
      const rel = path.relative(DST, abs).split(path.sep).join("/");
      if (keep(rel)) continue;
      if (e.isDirectory() && holdsKeep(rel)) rm(abs);
      else fs.rmSync(abs, { recursive: true, force: true });
    }
  })(DST);
}

let files = 0, bytes = 0;
const copied = [];
function copy(srcRel, dstRel) {
  const from = path.join(SRC, srcRel);
  if (!fs.existsSync(from)) { console.log(`  skip (not in source): ${srcRel}`); return; }
  const st = fs.statSync(from);
  if (st.isDirectory()) {
    if (excluded(srcRel, true)) return;
    for (const e of fs.readdirSync(from, { withFileTypes: true })) {
      const rel = `${srcRel}/${e.name}`;
      if (e.isDirectory() ? !excluded(rel, true) : !excluded(rel, false)) copy(rel, `${dstRel}/${e.name}`);
    }
    return;
  }
  const to = path.join(DST, dstRel);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
  files++; bytes += st.size;
  copied.push(dstRel);
}

function editJson(rel, fn) {
  const p = path.join(DST, rel);
  const obj = JSON.parse(fs.readFileSync(p, "utf8"));
  fn(obj);
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + "\n");
}

function scan() {
  const hits = [];
  const self = path.relative(DST, SELF).split(path.sep).join("/");
  for (const rel of walk(DST)) {
    if (rel === self || !TEXT_EXT.test(path.posix.basename(rel))) continue;
    const buf = fs.readFileSync(path.join(DST, rel));
    if (buf.subarray(0, 8192).includes(0)) continue; // binary
    const allowed = (label) => SCAN_EXCEPTIONS.some(([f, l]) => f === rel && l === label);
    buf.toString("utf8").split(/\r?\n/).forEach((line, i) => {
      for (const [label, re] of PATTERNS) if (re.test(line) && !allowed(label)) hits.push(`${rel}:${i + 1}: ${label}: ${line.trim().slice(0, 160)}`);
      for (const m of line.matchAll(EMAIL)) if (!FAKE_EMAIL.some((re) => re.test(m[0])) && !allowed("email")) hits.push(`${rel}:${i + 1}: email: ${m[0]}`);
    });
  }
  return hits;
}

// --- run --------------------------------------------------------------------------------------
if (path.relative(SRC, DST) === "" || !fs.existsSync(path.join(SRC, "packages"))) {
  console.error(`source ${SRC} is not a Lanes worktree (or equals staging)`); process.exit(2);
}
console.log(`sync ${SRC} -> ${DST}`);
clean();
for (const [s, d] of ALLOW) copy(s, d);

const license = path.join(DST, "LICENSE");
if (!fs.existsSync(license)) { console.error("staging has no LICENSE (Apache-2.0): add it first"); process.exit(2); }
fs.copyFileSync(license, path.join(DST, "packages/extension/LICENSE.txt"));

const links = { homepage: REPO_URL, bugs: { url: `${REPO_URL}/issues` } };
editJson("package.json", (p) => {
  Object.assign(p, { license: "Apache-2.0", repository: { type: "git", url: `${REPO_URL}.git` }, ...links });
  delete p.scripts["test:site"]; // the site is not public
});
const pkgs = fs.readdirSync(path.join(DST, "packages")).filter((d) => fs.existsSync(path.join(DST, "packages", d, "package.json")));
for (const d of pkgs) editJson(`packages/${d}/package.json`, (p) => {
  p.license = "Apache-2.0";
  if (d === "extension") Object.assign(p, { repository: { type: "git", url: `${REPO_URL}.git`, directory: "packages/extension" }, ...links });
});
editJson("package-lock.json", (l) => {
  for (const d of pkgs) if (l.packages[`packages/${d}`]) l.packages[`packages/${d}`].license = "Apache-2.0";
});

for (const [rel, from, to] of REWRITES) {
  const p = path.join(DST, rel);
  const text = fs.readFileSync(p, "utf8");
  if (from instanceof RegExp ? !from.test(text) : !text.includes(from)) console.log(`  rewrite no longer needed: ${rel} (${from})`);
  fs.writeFileSync(p, from instanceof RegExp ? text.replace(from, to) : text.split(from).join(to));
}

// Links in copied Markdown: a relative link to a path missing from staging becomes its plain text, and a link to an
// issue of the private repository becomes "#NNN" (those issues do not exist in the public repository).
const DESIGN = new Set([...fs.readFileSync(path.join(DST, "docs/design.md"), "utf8").matchAll(/id="adr-(\d{4})"/g)].map((m) => m[1]));
const ISSUE = "https://github\\.com/mfmatozza/lanes/issues/(\\d+)";
const linkCounts = [];
for (const rel of copied.filter((r) => r.endsWith(".md"))) {
  const p = path.join(DST, rel);
  let n = 0;
  const text = fs.readFileSync(p, "utf8")
    .replace(/!?\[([^\]\n]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (all, label, target) => {
      const issue = target.match(new RegExp(`^${ISSUE}$`));
      if (issue) { n++; return `#${issue[1]}`; }
      if (/^([a-z]+:|#)/i.test(target)) return all;
      const adr = target.match(/(?:^|\/)(?:decisions\/)?(\d{4})-[^/#)]*\.md(?:#.*)?$/);
      if (adr && DESIGN.has(adr[1])) { n++; return `[${label}](${path.relative(path.dirname(p), path.join(DST, "docs/design.md")).split(path.sep).join("/")}#adr-${adr[1]})`; }
      if (fs.existsSync(path.resolve(path.dirname(p), decodeURI(target.split("#")[0])))) return all;
      n++; return label;
    })
    .replace(new RegExp(ISSUE, "g"), (_, num) => { n++; return `#${num}`; });
  if (n) { fs.writeFileSync(p, text); linkCounts.push(`${String(n).padStart(4)}  ${rel}`); }
}
console.log(`links made plain text: ${linkCounts.length} files`);
for (const c of linkCounts) console.log(c);

const hits = scan();
console.log(`copied ${files} files, ${(bytes / 1024).toFixed(0)} KB; scan hits: ${hits.length}`);
if (hits.length) {
  console.error("\nPrivate data or secrets found. Exclude the file in ALLOW/EXCLUDE, or add a commented SCAN_EXCEPTIONS entry:");
  for (const h of hits) console.error("  " + h);
  process.exit(1);
}
