// Colour is for a person at a terminal only: off when NO_COLOR is set or stdout is not a TTY, so piped output stays plain.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { colorOn } from "../src/cli.ts";
import { requestLines } from "../src/team.ts";

test("colour only on a TTY with NO_COLOR unset", () => {
  assert.equal(colorOn({ isTTY: true }, {}), true);
  assert.equal(colorOn({ isTTY: true }, { NO_COLOR: "1" }), false);
  assert.equal(colorOn({ isTTY: false }, {}), false);
  assert.equal(colorOn({}, {}), false, "a pipe or a file has no isTTY");
});

test("piped output of the CLI has no escape codes, with or without NO_COLOR", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "lanes-color-"));
  try {
    for (const extra of [{}, { NO_COLOR: "1" }]) {
      // A closed port: `status` prints its coloured offline line.
      const r = spawnSync(process.execPath, [path.join(import.meta.dirname, "..", "src", "cli.ts"), "status", "--server", "http://127.0.0.1:1"], { encoding: "utf8", env: { ...process.env, LANES_HOME: home, LANES_AUTOSTART: "0", FORCE_COLOR: "1", ...extra } });
      assert.equal(r.status, 1);
      assert.match(r.stdout, /^Lanes is offline at http:\/\/127\.0\.0\.1:1: coordination is paused/);
      assert.ok(!r.stdout.includes("\x1b["), "no ANSI codes when stdout is a pipe");
    }
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("requests line up in columns; a reply sits on its own line", () => {
  const base = { repo: "r", text: "Check the cache", scope: "read" as const, createdAt: 0, expiresAt: 600_000 };
  const lines = requestLines([
    { ...base, id: "aaaaaaaa", from: "Bea", to: "ana", status: "pending" },
    { ...base, id: "bbbbbbbb", from: "ana", to: "Cy", status: "delivered", scope: "edit", reply: "Done" },
  ], "Ana", 0);
  assert.deepEqual(lines, [
    "aaaaaaaa  Waiting    from Bea  Read only       ~10 min left  Check the cache",
    "bbbbbbbb  Delivered  to Cy     May edit files                Check the cache",
    "    Cy's agent replied: Done",
  ]);
});
