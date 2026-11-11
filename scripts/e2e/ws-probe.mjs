// Probes the /v1/events WebSocket of a throwaway server (never a real one): auth, Origin, Host, limits, malformed frames.
// Usage: node scripts/e2e/ws-probe.mjs   (starts and stops its own server on a free port, token "probe-token")
import * as crypto from "node:crypto";
import * as net from "node:net";
import { startServer } from "../../packages/server/src/server.ts";

const TOKEN = "probe-token-" + "x".repeat(20);
const server = await startServer({ port: 0, token: TOKEN, heartbeatMs: 60_000 });
const port = Number(new URL(server.url).port);
const results = [];
const check = (name, ok, detail = "") => { results.push(ok); console.log(`${ok ? "ok  " : "FAIL"} ${name} ${detail}`); };

function upgrade({ path = "/v1/events", headers = {}, host = `127.0.0.1:${port}`, token = TOKEN, raw } = {}) {
  return new Promise((resolve) => {
    const s = net.connect(port, "127.0.0.1");
    const key = crypto.randomBytes(16).toString("base64");
    const lines = [`GET ${path} HTTP/1.1`, `Host: ${host}`, "Connection: Upgrade", "Upgrade: websocket", "Sec-WebSocket-Version: 13", `Sec-WebSocket-Key: ${key}`];
    if (token) lines.push(`Authorization: Bearer ${token}`);
    for (const [k, v] of Object.entries(headers)) lines.push(`${k}: ${v}`);
    s.write((raw ?? lines.join("\r\n")) + "\r\n\r\n");
    s.on("error", () => {});
    let buf = Buffer.alloc(0);
    s.on("data", (d) => { buf = Buffer.concat([buf, d]); });
    const finish = () => resolve({ status: Number(/^HTTP\/1.1 (\d+)/.exec(buf.toString("latin1"))?.[1] ?? 0), socket: s, buf });
    setTimeout(finish, 400);
    s.on("close", finish);
  });
}
const mask = (payload, opcode = 1, fin = true) => {
  const m = crypto.randomBytes(4);
  const len = payload.length;
  const head = len < 126 ? Buffer.from([(fin ? 0x80 : 0) | opcode, 0x80 | len]) : len < 65536 ? Buffer.from([(fin ? 0x80 : 0) | opcode, 0x80 | 126, len >> 8, len & 255]) : null;
  return Buffer.concat([head, m, Buffer.from(payload.map((b, i) => b ^ m[i % 4]))]);
};

let r = await upgrade({ token: "" });
check("no token is refused", r.status === 401, `(${r.status})`); r.socket.destroy();
r = await upgrade({ token: "wrong" });
check("wrong token is refused", r.status === 401, `(${r.status})`); r.socket.destroy();
r = await upgrade({ path: `/v1/events?token=${TOKEN}`, token: "" });
check("token in the query string is accepted (browser clients)", r.status === 101, `(${r.status})`); r.socket.destroy();
r = await upgrade({ headers: { Origin: "http://evil.example" } });
check("foreign Origin is refused", r.status === 403, `(${r.status})`); r.socket.destroy();
r = await upgrade({ headers: { Origin: "null" } });
check("Origin: null is refused", r.status === 403, `(${r.status})`); r.socket.destroy();
r = await upgrade({ headers: { Origin: "http://localhost:3000" } });
console.log(`info a page on another local port (http://localhost:3000) with the token: ${r.status} (the token is what stops it)`); r.socket.destroy();
r = await upgrade({ host: "evil.example" });
check("foreign Host (DNS rebinding) is refused", r.status === 403, `(${r.status})`); r.socket.destroy();
r = await upgrade({ path: "/v1/state" });
check("upgrade to another path is refused", r.status === 404, `(${r.status})`); r.socket.destroy();

r = await upgrade();
check("valid upgrade", r.status === 101, `(${r.status})`);
const live = r.socket;
let closed = false; live.on("close", () => (closed = true));
live.write(mask([...Buffer.alloc(2000, 1)].length < 126 ? [] : [], 1)); // empty text frame is fine
live.write(Buffer.concat([Buffer.from([0x81, 0x80 | 126, 0x10, 0x00]), crypto.randomBytes(4)])); // announces a 4096-byte frame
await new Promise((x) => setTimeout(x, 500));
check("a frame over the limit closes the stream", closed);

r = await upgrade();
const unmasked = r.socket; let c2 = false; unmasked.on("close", () => (c2 = true));
unmasked.write(Buffer.from([0x81, 0x02, 0x68, 0x69])); // unmasked client frame
await new Promise((x) => setTimeout(x, 400));
check("an unmasked client frame closes the stream", c2);

// 128 streams, the 129th is refused
const open = [];
for (let i = 0; i < 130; i++) { const x = await upgrade(); open.push(x); }
const statuses = open.map((x) => x.status);
check("at most 128 streams", statuses.filter((s) => s === 101).length <= 128 && statuses.includes(503), `(${statuses.filter((s) => s === 101).length} open, ${statuses.filter((s) => s === 503).length} refused)`);
for (const x of open) x.socket.destroy();

// header flood
const flood = await upgrade({ headers: Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`X-${i}`, "y".repeat(500)])) });
check("a 100 KB header block is refused or dropped", flood.status !== 101, `(${flood.status})`); flood.socket.destroy();

await server.close();
console.log(results.every(Boolean) ? "ALL OK" : "SOME FAILED");
process.exit(results.every(Boolean) ? 0 : 1);
