// #48: the WebSocket snapshot stream. Every server and socket a test opens is closed before it ends.
import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import * as http from "node:http";
import type { Duplex } from "node:stream";
import { describe, test } from "node:test";
import { CLOSE, connectEvents, encodeFrame, FrameParser, OP } from "@lanes/core/ws.ts";
import { Coordinator } from "../src/coordinator.ts";
import { startServer } from "../src/server.ts";

const TOKEN = "t0k3n-for-ws-tests";
const auth = { authorization: `Bearer ${TOKEN}` };
const ref = (user: string) => ({ user, sessionId: user, repo: "r", label: "app" });
const until = async (cond: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
};

/** A raw upgrade request, so a test can send what a real client never would. */
function rawUpgrade(base: string, headers: Record<string, string>, path = "/v1/events"): Promise<{ status: number; socket?: Duplex; head?: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = http.request(base + path, {
      headers: { connection: "Upgrade", upgrade: "websocket", "sec-websocket-version": "13", "sec-websocket-key": crypto.randomBytes(16).toString("base64"), ...headers },
    });
    req.on("response", (res) => { res.resume(); resolve({ status: res.statusCode ?? 0 }); });
    req.on("upgrade", (res, socket, head) => resolve({ status: res.statusCode ?? 0, socket, head }));
    req.on("error", reject);
    req.end();
  });
}

describe("WS /v1/events", () => {
  test("pushes a snapshot on connect and after each change, and the token is required", async () => {
    const server = await startServer({ port: 0, token: TOKEN });
    const seen: { agents: { user: string }[] }[] = [];
    const client = connectEvents(server.url + "/v1/events", auth, { onMessage: (t) => seen.push(JSON.parse(t).snapshot), onClose: () => {} });
    try {
      await until(() => seen.length === 1);
      assert.equal(seen[0]!.agents.length, 0);
      server.coordinator.session({ ...ref("Ana"), event: "start" });
      server.coordinator.session({ ...ref("Bea"), event: "start" });
      await until(() => seen.at(-1)!.agents.length === 2);
      assert.ok(seen.length <= 3, "two changes inside 50 ms are sent as one or two snapshots, never per event of a burst");
    } finally {
      client.close();
      await server.close();
    }
  });

  test("one change builds one snapshot for every viewer, not one per viewer (#261)", async () => {
    const coordinator = new Coordinator();
    const server = await startServer({ port: 0, token: TOKEN, coordinator });
    const counts = Array.from({ length: 5 }, () => 0);
    const clients = counts.map((_, i) => connectEvents(server.url + "/v1/events", auth, { onMessage: () => counts[i]!++, onClose: () => {} }));
    try {
      await until(() => counts.every((n) => n === 1));
      let built = 0;
      const real = coordinator.snapshot.bind(coordinator);
      coordinator.snapshot = () => (built++, real());
      coordinator.session({ ...ref("Ana"), event: "start" });
      await until(() => counts.every((n) => n === 2));
      assert.equal(built, 1);
    } finally {
      for (const c of clients) c.close();
      await server.close();
    }
  });

  test("a missing or wrong token, Host or Origin is refused; the query token works", async () => {
    const server = await startServer({ port: 0, token: TOKEN });
    try {
      assert.equal((await rawUpgrade(server.url, {})).status, 401);
      assert.equal((await rawUpgrade(server.url, { authorization: "Bearer wrong" })).status, 401);
      assert.equal((await rawUpgrade(server.url, { ...auth, host: "evil.example" })).status, 403);
      assert.equal((await rawUpgrade(server.url, { ...auth, origin: "http://evil.example" })).status, 403);
      assert.equal((await rawUpgrade(server.url, { ...auth, origin: "null" })).status, 403);
      assert.equal((await rawUpgrade(server.url, auth, "/v1/other")).status, 404);
      assert.equal((await rawUpgrade(server.url, { ...auth, "sec-websocket-key": "short" })).status, 400);
      assert.equal((await rawUpgrade(server.url, { ...auth, "sec-websocket-version": "8" })).status, 400);
      const ok = await rawUpgrade(server.url, { origin: server.url }, `/v1/events?token=${TOKEN}`);
      assert.equal(ok.status, 101);
      ok.socket!.destroy();
    } finally {
      await server.close();
    }
  });

  test("an oversized client frame closes the connection with 1009; an unmasked one with 1002", async () => {
    const server = await startServer({ port: 0, token: TOKEN });
    try {
      for (const [frame, code] of [
        [encodeFrame(OP.text, Buffer.alloc(2000, 1), true), CLOSE.tooBig],
        [encodeFrame(OP.text, Buffer.from("hi"), false), CLOSE.protocol],
      ] as const) {
        const { socket } = await rawUpgrade(server.url, auth);
        const parser = new FrameParser(1 << 20, false);
        const got = new Promise<number>((resolve) => socket!.on("data", (d: Buffer) => { for (const f of parser.push(d)) if (f.opcode === OP.close) resolve(f.payload.readUInt16BE(0)); }));
        socket!.write(frame);
        assert.equal(await got, code);
        socket!.destroy();
      }
    } finally {
      await server.close();
    }
  });

  test("the heartbeat pings, answers pings, and drops a client that goes silent", async () => {
    const server = await startServer({ port: 0, token: TOKEN, heartbeatMs: 100 });
    try {
      const { socket } = await rawUpgrade(server.url, auth);
      const parser = new FrameParser(1 << 20, false);
      let pings = 0;
      let closed = false;
      socket!.on("data", (d: Buffer) => { for (const f of parser.push(d)) if (f.opcode === OP.ping) pings++; });
      socket!.on("close", () => (closed = true));
      await until(() => pings >= 1);
      await until(() => closed, 2000); // never answered: dropped after 2.5 heartbeats
    } finally {
      await server.close();
    }
  });

  test("a client that answers pings stays connected, and a refused 129th connection does not break the others", async () => {
    const server = await startServer({ port: 0, token: TOKEN, heartbeatMs: 100 });
    const sockets: Duplex[] = [];
    try {
      let closed = false;
      let opened = false;
      const client = connectEvents(server.url + "/v1/events", auth, { onMessage: () => (opened = true), onClose: () => (closed = true) });
      await until(() => opened);
      // The other 127 answer too: opening them can take longer than the 250 ms after which a silent stream is dropped (Windows).
      for (let i = 0; i < 127; i++) {
        const s = (await rawUpgrade(server.url, auth)).socket!;
        s.on("data", () => s.write(encodeFrame(OP.pong, Buffer.alloc(0), true)));
        sockets.push(s);
      }
      // Refused: a 503 answer, or on a loaded Windows machine a reset before the answer is read. Either way no stream opens.
      const refused = await rawUpgrade(server.url, auth).then((r) => r.status, (e: NodeJS.ErrnoException) => e.code);
      assert.ok(refused === 503 || refused === "ECONNRESET", `129th connection: ${refused}`);
      await new Promise((r) => setTimeout(r, 700)); // more than 2.5 heartbeats: the real client kept answering
      assert.equal(closed, false);
      client.close();
    } finally {
      for (const s of sockets) s.destroy();
      await server.close();
    }
  });

  test("closing the server closes every stream (nothing is left listening)", async () => {
    const server = await startServer({ port: 0, token: TOKEN });
    let reason = "";
    connectEvents(server.url + "/v1/events", auth, { onMessage: () => {}, onClose: (r) => (reason = r) });
    await new Promise((r) => setTimeout(r, 100)); // let it connect
    await server.close();
    await until(() => reason !== "");
    await assert.rejects(fetch(server.url + "/health"));
  });
});
