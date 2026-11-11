// #184: `lanes server` on a busy port says what is there instead of ending silently with exit 0.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

const cli = path.join(import.meta.dirname, "..", "src", "cli.ts");

function run(port: number, home: string): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [cli, "server", "--port", String(port)], { env: { ...process.env, LANES_HOME: home, LANES_AUTOSTART: "0" } });
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("close", (code) => resolve({ code, out, err }));
  });
}

const listen = (server: net.Server): Promise<number> => new Promise((r) => server.listen(0, "127.0.0.1", () => r((server.address() as net.AddressInfo).port)));

test("a busy port: another program is an error, a Lanes server is reported as running", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "lanes-port-"));
  const other = net.createServer();
  const lanes = http.createServer((_req, res) => res.end("{}"));
  try {
    const p1 = await listen(other);
    const a = await run(p1, home);
    assert.equal(a.code, 1);
    assert.match(a.err, new RegExp(`Port ${p1} is already in use.*--port <n>`));
    assert.doesNotMatch(a.err + a.out, /Token/, "no token printed for a server that did not start");

    const p2 = await listen(lanes);
    const b = await run(p2, home);
    assert.equal(b.code, 0);
    assert.match(b.out, new RegExp(`already running at http://127\\.0\\.0\\.1:${p2}`));
  } finally {
    other.close();
    lanes.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});
