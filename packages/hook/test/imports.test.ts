// importsOf and the turn-end stale-dependency check (team context, M.2: the I1/I3 benchmark).
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { staleDependencies } from "../src/hook.ts";
import { importsOf } from "../src/imports.ts";

function tree(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lanes-imports-"));
  for (const [f, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
    fs.writeFileSync(path.join(root, f), text);
  }
  return root;
}

test("importsOf resolves relative JS/TS specifiers and Python relative imports; packages are ignored", () => {
  const root = tree({
    "src/a.ts": [
      'import { x } from "./b.js";',
      'import "./side";',
      'import y from "../lib";',
      'const z = await import("./dyn");',
      'const r = require("./req");',
      'import fs from "node:fs";',
      'import lodash from "lodash";',
      'import gone from "./missing";',
    ].join("\n"),
    "src/b.ts": "",
    "src/side.tsx": "",
    "lib/index.ts": "",
    "src/dyn.mjs": "",
    "src/req.cjs": "",
    "py/pkg/mod.py": "from .util import f\nfrom ..top import g\nfrom . import h\n",
    "py/pkg/util.py": "",
    "py/top/__init__.py": "",
  });
  assert.deepEqual(importsOf(root, "src/a.ts").sort(), ["lib/index.ts", "src/b.ts", "src/dyn.mjs", "src/req.cjs", "src/side.tsx"]);
  assert.deepEqual(importsOf(root, "py/pkg/mod.py").sort(), ["py/pkg/util.py", "py/top/__init__.py"]);
  assert.deepEqual(importsOf(root, "nope.ts"), []);
});

test("stale dependencies: a read or imported file a teammate changed, and a new teammate file that imports an edited one", () => {
  const root = tree({
    "src/billing/index.ts": "export function addOrder() {}",
    "src/handlers/invoices.ts": 'import { addOrder } from "../billing/index.js";',
    "src/db/orders.ts": "",
    "src/other.ts": "",
  });
  // B side: B read billing and wrote a new caller; a teammate's change to billing arrived this turn.
  const b = staleDependencies(root, ["src/handlers/invoices.ts"], [], ["src/billing/index.ts", "src/other.ts"]);
  assert.deepEqual(b?.paths, ["src/billing/index.ts"]);
  assert.match(b!.text, /changed src\/billing\/index\.ts, which your code uses\. Re-read it/);
  assert.match(b!.text, /No need to ask the user/);
  assert.deepEqual(staleDependencies(root, [], ["src/db/orders.ts"], ["src/db/orders.ts"])?.paths, ["src/db/orders.ts"]);
  // A side: A changed billing; B's new caller arrived.
  const a = staleDependencies(root, ["src/billing/index.ts"], [], ["src/handlers/invoices.ts"]);
  assert.deepEqual(a?.paths, ["src/handlers/invoices.ts"]);
  assert.match(a!.text, /added or changed src\/handlers\/invoices\.ts, which imports a file you changed/);
  // Nothing relevant: unrelated arrivals, nothing arrived, or the arrival is a file this turn edited (left to re-apply).
  assert.equal(staleDependencies(root, ["src/handlers/invoices.ts"], [], ["src/other.ts"]), undefined);
  assert.equal(staleDependencies(root, ["src/handlers/invoices.ts"], ["src/billing/index.ts"], []), undefined);
  assert.equal(staleDependencies(root, ["src/billing/index.ts"], ["src/billing/index.ts"], ["src/billing/index.ts"]), undefined);
});
