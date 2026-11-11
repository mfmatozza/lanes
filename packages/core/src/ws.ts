// A tiny WebSocket (RFC 6455) for the snapshot stream: the handshake key, a frame codec and a client. No dependency (#48).
// shortcut: no fragmentation, extensions or subprotocols; a fragmented frame is a protocol error. Upgrade to `ws` if Lanes ever streams big or binary data.
import * as crypto from "node:crypto";
import * as http from "node:http";
import type { Duplex } from "node:stream";

export const OP = { text: 0x1, binary: 0x2, close: 0x8, ping: 0x9, pong: 0xa } as const;
export const CLOSE = { normal: 1000, protocol: 1002, tooBig: 1009 } as const;
const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

export const acceptKey = (key: string): string => crypto.createHash("sha1").update(key + GUID).digest("base64");
/** A handshake key is 16 random bytes in base64. */
export const validKey = (key: unknown): key is string => typeof key === "string" && Buffer.from(key, "base64").length === 16 && /^[A-Za-z0-9+/]{22}==$/.test(key);

export function encodeFrame(opcode: number, payload: Buffer = Buffer.alloc(0), mask = false): Buffer {
  const n = payload.length;
  const head = n < 126 ? Buffer.from([0x80 | opcode, n]) : n < 65536 ? Buffer.from([0x80 | opcode, 126, n >> 8, n & 255]) : Buffer.concat([Buffer.from([0x80 | opcode, 127]), Buffer.alloc(8)]);
  if (n >= 65536) head.writeBigUInt64BE(BigInt(n), 2);
  if (!mask) return Buffer.concat([head, payload]);
  head[1]! |= 0x80;
  const key = crypto.randomBytes(4);
  return Buffer.concat([head, key, payload.map((b, i) => b ^ key[i % 4]!)]);
}

export class WsError extends Error {
  code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

export interface Frame { opcode: number; payload: Buffer }

/** Splits a byte stream into frames. Throws WsError for what the peer must be closed for. */
export class FrameParser {
  private buf = Buffer.alloc(0);
  private readonly maxPayload: number;
  private readonly masked: boolean;
  /** `maxPayload` bounds one frame; `masked` is what the peer must do (a client masks, a server does not). */
  constructor(maxPayload: number, masked: boolean) {
    this.maxPayload = maxPayload;
    this.masked = masked;
  }

  push(chunk: Buffer): Frame[] {
    this.buf = Buffer.concat([this.buf, chunk]);
    const frames: Frame[] = [];
    for (;;) {
      if (this.buf.length < 2) return frames;
      const b0 = this.buf[0]!;
      const b1 = this.buf[1]!;
      if (!(b0 & 0x80) || b0 & 0x70) throw new WsError(CLOSE.protocol, "fragmented or extended frame");
      if (Boolean(b1 & 0x80) !== this.masked) throw new WsError(CLOSE.protocol, this.masked ? "frame is not masked" : "frame is masked");
      const opcode = b0 & 0x0f;
      let len = b1 & 0x7f;
      let at = 2;
      if (len === 126 || len === 127) {
        const need = len === 126 ? 2 : 8;
        if (this.buf.length < at + need) return frames;
        const big = len === 126 ? BigInt(this.buf.readUInt16BE(at)) : this.buf.readBigUInt64BE(at);
        if (big > BigInt(this.maxPayload)) throw new WsError(CLOSE.tooBig, "frame too big");
        len = Number(big);
        at += need;
      }
      if (len > this.maxPayload) throw new WsError(CLOSE.tooBig, "frame too big");
      if (opcode >= 0x8 && len > 125) throw new WsError(CLOSE.protocol, "control frame too long");
      if (this.buf.length < at + (this.masked ? 4 : 0) + len) return frames;
      let payload: Buffer;
      if (this.masked) {
        const key = this.buf.subarray(at, at + 4);
        payload = Buffer.from(this.buf.subarray(at + 4, at + 4 + len).map((b, i) => b ^ key[i % 4]!));
        at += 4;
      } else {
        payload = Buffer.from(this.buf.subarray(at, at + len));
      }
      this.buf = this.buf.subarray(at + len);
      frames.push({ opcode, payload });
    }
  }
}

export interface EventsClient {
  close(): void;
}

/**
 * Connects to a `/v1/events` stream and calls `onMessage` with each text frame. `onClose` fires exactly once, whatever the
 * reason (refused upgrade, network error, silence for `idleMs`, the server closing). Answers pings itself.
 */
export function connectEvents(
  url: string,
  headers: Record<string, string>,
  handlers: { onOpen?: () => void; onMessage: (text: string) => void; onClose: (reason: string) => void },
  idleMs = 50_000,
): EventsClient {
  let done = false;
  let socket: Duplex | undefined;
  let idle: ReturnType<typeof setTimeout> | undefined;
  const finish = (reason: string) => {
    if (done) return;
    done = true;
    clearTimeout(idle);
    socket?.destroy();
    handlers.onClose(reason);
  };
  const key = crypto.randomBytes(16).toString("base64");
  const req = http.request(url.replace(/^ws/, "http"), {
    headers: { ...headers, connection: "Upgrade", upgrade: "websocket", "sec-websocket-version": "13", "sec-websocket-key": key },
  });
  req.on("error", (err) => finish(err.message));
  req.on("response", (res) => { res.resume(); finish(`server answered ${res.statusCode}`); });
  req.on("upgrade", (res, sock, head) => {
    if (res.headers["sec-websocket-accept"] !== acceptKey(key)) return void (sock.destroy(), finish("bad handshake"));
    socket = sock;
    // Server frames are small; a snapshot is the biggest, and it is bounded by the server's own limits.
    const parser = new FrameParser(16 * 1024 * 1024, false);
    const arm = () => { clearTimeout(idle); idle = setTimeout(() => finish("no heartbeat"), idleMs); };
    const feed = (chunk: Buffer) => {
      arm();
      try {
        for (const f of parser.push(chunk)) {
          if (f.opcode === OP.text) handlers.onMessage(f.payload.toString("utf8"));
          else if (f.opcode === OP.ping) sock.write(encodeFrame(OP.pong, f.payload, true));
          else if (f.opcode === OP.close) return finish("closed by the server");
        }
      } catch (err) {
        finish((err as Error).message);
      }
    };
    sock.on("data", feed);
    sock.on("close", () => finish("connection closed"));
    sock.on("error", (err) => finish(err.message));
    arm();
    handlers.onOpen?.();
    if (head.length) feed(head);
  });
  req.end();
  return {
    close() {
      if (!done && socket) socket.write(encodeFrame(OP.close, Buffer.from([0x03, 0xe8]), true));
      finish("closed");
    },
  };
}
