// #186: a failed setup commit is one actionable line, not git's paragraph and warnings.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { makeRepo } from "../../core/test/helpers.ts";
import { init } from "../src/cli.ts";

test("init without a git identity says how to set it, in one line, and leaves the files", () => {
  const { main, cleanup } = makeRepo();
  const cfg = fs.mkdtempSync(path.join(os.tmpdir(), "lanes-gitcfg-"));
  const saved = { ...process.env };
  try {
    fs.writeFileSync(path.join(cfg, "empty"), "");
    for (const k of ["GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL", "EMAIL"]) delete process.env[k];
    Object.assign(process.env, { GIT_CONFIG_GLOBAL: path.join(cfg, "empty"), GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "user.useConfigOnly", GIT_CONFIG_VALUE_0: "true" });
    const assets = fs.mkdtempSync(path.join(os.tmpdir(), "lanes-assets-"));
    fs.writeFileSync(path.join(assets, "hook.cjs"), "// hook");
    fs.writeFileSync(path.join(assets, "server.cjs"), "// server");
    assert.throws(
      () => init(main, { commit: true, assets }),
      (err: Error) => {
        assert.match(err.message, /^The Lanes files were written but not committed: git does not know who you are\. Run `git config user\.name/);
        assert.match(err.message, /--no-commit\.$/);
        assert.doesNotMatch(err.message, /\n|warning|Please tell me/);
        return true;
      },
    );
    assert.ok(fs.existsSync(path.join(main, ".lanes", "hook.cjs")));
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
    cleanup();
    fs.rmSync(cfg, { recursive: true, force: true });
  }
});
