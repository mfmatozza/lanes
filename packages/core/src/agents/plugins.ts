// In-process plugins for agents without shell hooks: opencode (https://opencode.ai/docs/plugins/) and Amp
// (https://ampcode.com/docs/plugin-api), both read 2026-11-02. `lanes init --agents opencode|amp` writes one file into the
// repository's project plugin folder; it runs the bundled .lanes/hook.cjs with a Claude-format payload, so the hook needs no
// per-agent code. Dependency-free JavaScript (valid TypeScript too), node: modules only, which Bun (both hosts) provides.
// Built from the docs; not run against a real opencode or Amp.

/** First line of every file we write: `lanes off` and a re-init only touch a plugin that starts with it. */
export const PLUGIN_MARKER = "// Lanes plugin, written by `lanes init`; `lanes off` removes it.";

/** The shared part: run the hook, return the context it printed, never throw (fail open, ADR-0019). */
const runner = (agent: string) => `${PLUGIN_MARKER}
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const HOOK = fileURLToPath(new URL("../../.lanes/hook.cjs", import.meta.url));
const notes = new Map(); // session -> text for the next place the agent's model reads it
const calls = new Map(); // tool call -> the payload sent before it

function lanes(event, payload, ms) {
  return new Promise((resolve) => {
    let out = "";
    try {
      const child = spawn("node", ["--no-warnings", HOOK, event, "--lanes", "${agent}"], { stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
      const timer = setTimeout(() => child.kill(), ms);
      child.on("error", () => resolve(""));
      child.stdout.on("data", (d) => (out += d));
      child.on("close", () => {
        clearTimeout(timer);
        try {
          resolve(JSON.parse(out).hookSpecificOutput?.additionalContext ?? "");
        } catch {
          resolve("");
        }
      });
      child.stdin.on("error", () => {});
      child.stdin.end(JSON.stringify(payload));
    } catch {
      resolve("");
    }
  });
}

function later(session, text) {
  if (text) notes.set(session, [notes.get(session), text].filter(Boolean).join(" "));
}
function take(session) {
  const text = notes.get(session);
  notes.delete(session);
  return text;
}

// An edit tool call as Claude's fields: a patch's files are read from its "*** Update File:" lines by the hook.
function edit(tool, args = {}) {
  if (tool === "apply_patch") return { tool_name: "apply_patch", tool_input: { command: String(args.patchText ?? args.patch ?? args.input ?? "") } };
  const file = args.filePath ?? args.path ?? args.file_path;
  const old = args.oldString ?? args.old_str;
  return { tool_name: tool === "write" || tool === "create_file" ? "Write" : "Edit", tool_input: { file_path: file, ...(typeof old === "string" && { old_string: old }) } };
}
`;

/**
 * opencode (and Kilo Code): `tool.execute.before/after` (edit, write, apply_patch), `session.created` and `session.idle` events. opencode has
 * no documented way for a plugin to add text to the model's context except the tool result, so every note waits for the next
 * edit's result. Throwing in tool.execute.before blocks the tool: nothing here throws.
 * shortcut: event payload fields (`properties.sessionID`, `properties.info.id`) and tool.execute.after's `output.output` are
 * from opencode's plugin types, not its docs page; no prompt hook, so commits are titled "Agent changes".
 */
export const opencodePlugin = (agent = "opencode") => `${runner(agent)}
const EDITS = new Set(["edit", "write", "apply_patch"]);

export const LanesPlugin = async ({ directory }) => ({
  event: async ({ event }) => {
    try {
      const session = event.properties?.sessionID ?? event.properties?.info?.id;
      if (!session) return;
      if (event.type === "session.created") later(session, await lanes("start", { session_id: session, cwd: directory }, 10000));
      else if (event.type === "session.idle") await lanes("stop", { session_id: session, cwd: directory }, 90000);
      else if (event.type === "session.deleted") await lanes("end", { session_id: session, cwd: directory }, 5000);
    } catch {}
  },
  "tool.execute.before": async (input, output) => {
    try {
      if (!EDITS.has(input.tool)) return;
      const payload = { session_id: input.sessionID, cwd: directory, ...edit(input.tool, output?.args) };
      calls.set(input.callID, payload);
      later(input.sessionID, await lanes("pre", payload, 300000));
    } catch {}
  },
  "tool.execute.after": async (input, output) => {
    try {
      const payload = calls.get(input.callID);
      if (!payload) return;
      calls.delete(input.callID);
      later(input.sessionID, await lanes("post", payload, 40000));
      const text = take(input.sessionID);
      if (text && output && typeof output.output === "string") output.output += "\\n\\n" + text;
    } catch {}
  },
});
`;

/**
 * Amp: `session.start`, `agent.start` (the prompt: the team brief and waiting notes go back as its message), `tool.call` on
 * edit_file, create_file and apply_patch (always `{action: "allow"}`: the plugin never decides, Amp's own permissions apply),
 * `tool.result`, `agent.end`.
 * shortcut: the edit tools' input field names and ToolCallEvent's `toolUseID`/`input`/`thread` are not on the docs page read;
 * `display: false` is our guess for "not shown to the user". Check on a real Amp.
 */
export const AMP_PLUGIN = `${runner("amp")}
const EDITS = new Set(["edit_file", "create_file", "apply_patch"]);

export default function (amp) {
  const cwd = () => (amp.system?.workspaceRoot ? amp.helpers.filePathFromURI(amp.system.workspaceRoot) : process.cwd());
  const key = (event) => event.toolUseID ?? event.thread?.id + ":" + event.tool;
  amp.on("session.start", async (event) => {
    try {
      later(event.thread.id, await lanes("start", { session_id: event.thread.id, cwd: cwd() }, 10000));
    } catch {}
  });
  amp.on("agent.start", async (event) => {
    try {
      const session = event.thread?.id ?? "amp";
      const prompt = typeof event.message === "string" ? event.message : String(event.message?.content ?? "");
      later(session, await lanes("prompt", { session_id: session, cwd: cwd(), prompt }, 15000));
      const text = take(session);
      if (text) return { message: { content: text, display: false } };
    } catch {}
  });
  amp.on("tool.call", async (event) => {
    try {
      if (EDITS.has(event.tool)) {
        const payload = { session_id: event.thread?.id ?? "amp", cwd: cwd(), ...edit(event.tool, event.input) };
        calls.set(key(event), payload);
        later(payload.session_id, await lanes("pre", payload, 300000));
      }
    } catch {}
    return { action: "allow" };
  });
  amp.on("tool.result", async (event) => {
    try {
      const payload = calls.get(key(event));
      if (!payload) return;
      calls.delete(key(event));
      later(payload.session_id, await lanes("post", payload, 40000));
    } catch {}
  });
  amp.on("agent.end", async (event) => {
    try {
      await lanes("stop", { session_id: event.thread?.id ?? "amp", cwd: cwd() }, 90000);
    } catch {}
  });
}
`;

/** Where each plugin goes, relative to the repository root. */
export const PLUGIN_FILES: Record<string, { file: string; source: string }> = {
  opencode: { file: ".opencode/plugins/lanes.js", source: opencodePlugin() },
  // Kilo Code's plugin API is opencode's ("behavior is identical to OpenCode": https://kilo.ai/docs/automate/extending/plugins).
  kilo: { file: ".kilo/plugin/lanes.js", source: opencodePlugin("kilo") },
  amp: { file: ".amp/plugins/lanes.ts", source: AMP_PLUGIN },
};
