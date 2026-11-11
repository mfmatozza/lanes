// `lanes init --agents` for the batch B agents (#261 S3.6): Antigravity, Factory Droid and Qwen Code hooks, opencode, Kilo
// Code and Amp plugins, and agents that only take MCP. Repository files only; user-level agent config is never read or
// written, only printed.
import * as fs from "node:fs";
import * as path from "node:path";
import { hasLanesAntigravityHooks, withLanesAntigravityHooks, withoutLanesAntigravityHooks } from "@lanes/core/agents/antigravity.ts";
import { withLanesFactoryHooks, withoutLanesFactoryHooks } from "@lanes/core/agents/factory.ts";
import { PLUGIN_FILES, PLUGIN_MARKER } from "@lanes/core/agents/plugins.ts";
import { withLanesQwenHooks } from "@lanes/core/agents/qwen.ts";
import { isLanesHook, withoutLanesHooks, type ClaudeSettings } from "@lanes/core/settings.ts";

const std = (p: string) => ({ mcpServers: { lanes: { command: "node", args: [p, "mcp"] } } });
const local = (p: string) => ({ mcp: { lanes: { type: "local", command: ["node", p, "mcp"], enabled: true } } });

/**
 * How to add `lanes mcp` to each agent, by hand (`p` is lanes.cjs): printed, never written, as it is user-level config.
 * Shapes from each agent's MCP docs (multiplayer/research/agent-integration.md, 2026-11-02 update).
 */
const MCP: Record<string, (p: string) => string> = {
  // Hooks or a plugin, plus MCP for the team tools.
  antigravity: (p) => `Antigravity: add to ~/.gemini/config/mcp_config.json (or /mcp in agy): ${JSON.stringify(std(p))}`,
  factory: (p) => `Factory Droid: add to ~/.factory/mcp.json: ${JSON.stringify({ mcpServers: { lanes: { type: "stdio", command: "node", args: [p, "mcp"] } } })}`,
  qwen: (p) => `qwen mcp add -s user -t stdio lanes node "${p}" mcp`,
  opencode: (p) => `opencode: add to ~/.config/opencode/opencode.json: ${JSON.stringify(local(p))}`,
  kilo: (p) => `Kilo Code: add to ~/.config/kilo/kilo.jsonc: ${JSON.stringify(local(p))}`,
  amp: (p) => `amp mcp add lanes -- node "${p}" mcp`,
  // MCP only: no hook or plugin a repository can install (see the research file for why).
  augment: (p) => `Augment (Auggie CLI and editors): add to ~/.augment/settings.json: ${JSON.stringify(std(p))}`,
  junie: (p) => `Junie: add to ~/.junie/mcp/mcp.json: ${JSON.stringify(std(p))}`,
  jetbrains: (p) => `JetBrains AI Assistant: Settings | Tools | AI Assistant | MCP, Add, As JSON: ${JSON.stringify(std(p))}`,
  continue: (p) => `Continue: add to ~/.continue/config.yaml: mcpServers: [{name: lanes, type: stdio, command: node, args: [${JSON.stringify(p)}, mcp]}]`,
  zed: (p) => `Zed: add to your settings.json: ${JSON.stringify({ context_servers: { lanes: { command: "node", args: [p, "mcp"] } } })}`,
  goose: (p) => `Goose: goose configure, Add Extension, Command-line Extension, command: node "${p}" mcp`,
  warp: (p) => `Warp: add to ~/.warp/.mcp.json: ${JSON.stringify(std(p))}`,
};

/** Agents this file handles, for the shared AGENTS list. */
export const MORE_AGENTS = Object.keys(MCP);

export const moreMcpSetup = (agent: string, p: string): string | undefined => MCP[agent]?.(p);

function readJson<T>(file: string, command: string): T {
  if (!fs.existsSync(file)) return {} as T;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    throw new Error(`${file} is not valid JSON. Fix it, then run \`lanes ${command}\` again.`);
  }
}

const hasHooks = (json: ClaudeSettings) => Object.values(json.hooks ?? {}).some((ms) => ms.some((m) => m.hooks.some(isLanesHook)));

/** The agents whose hooks live in a JSON file in the repository: where, how to add ours, how to take only ours out again. */
const HOOK_FILES: Record<string, { file: string; add: (json: any) => object; remove: (json: any) => object; has: (json: any) => boolean; note: string }> = {
  antigravity: {
    file: ".agents/hooks.json",
    add: withLanesAntigravityHooks,
    remove: withoutLanesAntigravityHooks,
    has: hasLanesAntigravityHooks,
    note: "Antigravity: each edit waits for a teammate's edit of the same file, then is published. No team brief at the prompt (Antigravity's prompt-time hook carries no prompt text): add `lanes mcp`. Built from Antigravity's docs, not yet run against it.",
  },
  factory: {
    file: ".factory/hooks.json",
    add: withLanesFactoryHooks,
    remove: withoutLanesFactoryHooks,
    has: (json) => hasHooks({ hooks: json }),
    note: "Factory Droid: same coordination as Claude Code (Edit and Create). Droid snapshots hooks at startup: restart it after `lanes init`. Built from Factory's docs, not yet run against it.",
  },
  qwen: {
    file: ".qwen/settings.json",
    add: withLanesQwenHooks,
    remove: withoutLanesHooks,
    has: hasHooks,
    note: "Qwen Code: same coordination as Claude Code (write_file and edit). It loads project hooks only in a trusted folder. Built from Qwen Code's docs, not yet run against it.",
  },
};

const PLUGIN_NOTES: Record<string, string> = {
  opencode: "opencode: the plugin in .opencode/plugins/lanes.js coordinates each edit; notes reach the agent with the next edit's result. Restart opencode to load it. Built from opencode's docs, not yet run against it.",
  kilo: "Kilo Code: the plugin in .kilo/plugin/lanes.js (opencode's plugin API) coordinates each edit. Restart Kilo to load it. Built from Kilo's docs, not yet run against it.",
  amp: "Amp: the plugin in .amp/plugins/lanes.ts coordinates each edit; the team brief goes in with each prompt. Run `plugins: reload` in a running Amp. Built from Amp's docs, not yet run against it.",
};

/** Writes this agent's repository files, if it has any. Returns the files (repo-relative, /-separated) and what to tell the user. */
export function installMore(root: string, agent: string): { files: string[]; notes: string[] } {
  const hooks = HOOK_FILES[agent];
  if (hooks) {
    const file = path.join(root, hooks.file);
    const json = readJson<object>(file, "init");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(hooks.add(json), null, 2) + "\n");
    return { files: [hooks.file], notes: [hooks.note] };
  }
  const plugin = PLUGIN_FILES[agent];
  if (plugin) {
    const file = path.join(root, plugin.file);
    if (fs.existsSync(file) && !fs.readFileSync(file, "utf8").startsWith(PLUGIN_MARKER)) throw new Error(`${file} exists and is not the Lanes plugin. Move it, then run \`lanes init\` again.`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, plugin.source);
    return { files: [plugin.file], notes: [PLUGIN_NOTES[agent]] };
  }
  return { files: [], notes: [] }; // MCP only: see moreMcpSetup
}

/** `lanes off` for these agents: removes only our hook entries and our plugin files, and folders left empty. Returns what changed. */
export function removeMore(root: string): string[] {
  const changed: string[] = [];
  for (const hooks of Object.values(HOOK_FILES)) {
    const file = path.join(root, hooks.file);
    const json = readJson<object>(file, "off");
    if (!hooks.has(json)) continue;
    const rest = hooks.remove(json);
    if (Object.keys(rest).length > 0) fs.writeFileSync(file, JSON.stringify(rest, null, 2) + "\n");
    else fs.rmSync(file);
    changed.push(hooks.file);
  }
  for (const { file: rel } of Object.values(PLUGIN_FILES)) {
    const f = path.join(root, rel);
    if (fs.existsSync(f) && fs.readFileSync(f, "utf8").startsWith(PLUGIN_MARKER)) {
      fs.rmSync(f);
      changed.push(rel);
    }
  }
  for (const dir of [".agents", ".factory", ".qwen", ".opencode/plugins", ".opencode", ".kilo/plugin", ".kilo", ".amp/plugins", ".amp"]) {
    try {
      fs.rmdirSync(path.join(root, dir)); // only when empty
    } catch {
      // missing, or something else lives there
    }
  }
  return changed;
}
