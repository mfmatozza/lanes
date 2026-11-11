// The manifest the stores read: store-facing fields exist and everything the walkthrough points at is real (#200).
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const dir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const manifest = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));

test("store fields: repository, bugs, homepage and a licence file (vsce warns without them)", () => {
  for (const k of ["repository", "bugs", "homepage"]) assert.ok(manifest[k], k);
  assert.ok(fs.existsSync(path.join(dir, "LICENSE.txt")));
});

test("the walkthrough's steps point at real media and registered commands", () => {
  const commands = new Set<string>(manifest.contributes.commands.map((c: { command: string }) => c.command));
  const steps = manifest.contributes.walkthroughs.flatMap((w: { steps: { description: string; media: { markdown: string } }[] }) => w.steps);
  assert.ok(steps.length >= 3);
  for (const s of steps) {
    assert.ok(fs.existsSync(path.join(dir, s.media.markdown)), s.media.markdown);
    for (const [, id] of s.description.matchAll(/\(command:([\w.]+)/g)) assert.ok(commands.has(id) || id === "lanes.agents.focus", `unknown command ${id}`);
    assert.ok(s.completionEvents?.length, `step "${s.title}" completes by itself`);
    assert.ok(!s.description.includes("`"), "walkthrough descriptions show backticks literally");
  }
});

test("the .vsix ships the CLI: dist/lanes.cjs next to hook.cjs and server.cjs, and runs `init` on its own (#252)", async () => {
  const ignore = fs.readFileSync(path.join(dir, ".vscodeignore"), "utf8");
  assert.doesNotMatch(ignore, /dist|\.cjs/, ".vscodeignore must not hide the bundles");
  for (const f of ["extension.cjs", "hook.cjs", "server.cjs", "lanes.cjs"]) assert.ok(fs.existsSync(path.join(dir, "dist", f)), `dist/${f}: run npm run build`);
  // The way an AI agent or a teammate runs it: plain node, in a repository, no `lanes` on PATH.
  const { spawnSync } = await import("node:child_process");
  const os = await import("node:os");
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "lanes-vsix-"));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "lanes-vsix-home-"));
  try {
    spawnSync("git", ["init", "-q", repo]);
    const r = spawnSync(process.execPath, [path.join(dir, "dist", "lanes.cjs"), "init", "--dir", repo, "--no-commit"], { encoding: "utf8", env: { ...process.env, LANES_HOME: home } });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(fs.existsSync(path.join(repo, ".lanes", "hook.cjs")) && fs.existsSync(path.join(repo, ".lanes", "server.cjs")));
    assert.match(fs.readFileSync(path.join(repo, ".claude", "settings.json"), "utf8"), /hook\.cjs/);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("every command a README, the walkthrough or the install guide shows in bold is a real command title", () => {
  const titles = new Set<string>(manifest.contributes.commands.map((c: { title: string }) => c.title));
  const root = path.resolve(dir, "..", "..");
  const files = [path.join(dir, "README.md"), path.join(root, "README.md"), path.join(root, "upload", "README.md"), path.join(root, "docs", "product", "install-verified.md"), ...fs.readdirSync(path.join(dir, "media", "walkthrough")).map((f) => path.join(dir, "media", "walkthrough", f))];
  for (const file of files.filter((f) => fs.existsSync(f))) {
    for (const [, name] of fs.readFileSync(file, "utf8").matchAll(/\*\*(Lanes: [^*]+)\*\*/g)) assert.ok(titles.has(name!), `${path.relative(root, file)} mentions "${name}", which is not a command`);
  }
  for (const s of manifest.contributes.walkthroughs[0].steps) for (const [, name] of s.description.matchAll(/\[([^\]]+)\]\(command:lanes\./g)) assert.ok(titles.has(`Lanes: ${name}`) || /Agents View/.test(name), name);
});

test("the server address and token are machine settings: a cloned repository's .vscode/settings.json cannot redirect the token, and Settings Sync does not upload it", () => {
  const props = manifest.contributes.configuration.properties;
  for (const k of ["lanes.serverUrl", "lanes.token"]) assert.equal(props[k].scope, "machine", k);
});

test("every view has a welcome for each connection problem, and the offline ones say coordination is paused (M6)", () => {
  const welcomes: { view: string; when?: string; contents: string }[] = manifest.contributes.viewsWelcome;
  for (const view of ["lanes.agents", "lanes.tasks", "lanes.team"]) {
    for (const state of ["loading", "offline", "refused", "error"]) assert.ok(welcomes.some((w) => w.view === view && w.when?.endsWith(`State == ${state}`)), `${view} ${state}`);
    assert.match(welcomes.find((w) => w.view === view && w.when?.endsWith("State == offline"))!.contents, /Coordination paused/);
  }
  const ids = new Set(manifest.contributes.commands.map((c: { command: string }) => c.command));
  for (const w of welcomes) for (const [, id] of w.contents.matchAll(/\(command:(lanes\.[\w.]+)/g)) assert.ok(ids.has(id), `welcome links to unknown command ${id}`);
});

test("every inline tree button is also in the right-click menu, so the keyboard (Shift+F10) reaches it", () => {
  const items: { command: string; group: string }[] = manifest.contributes.menus["view/item/context"];
  for (const { command } of items.filter((i) => i.group === "inline")) assert.ok(items.some((i) => i.command === command && i.group !== "inline"), command);
});
