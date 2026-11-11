import assert from "node:assert/strict";
import { test } from "node:test";
import { acceptKey, CLOSE, encodeFrame, FrameParser, OP, validKey, WsError } from "../src/ws.ts";

test("the handshake accept key matches the RFC 6455 example", () => {
  assert.equal(acceptKey("dGhlIHNhbXBsZSBub25jZQ=="), "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=");
  assert.ok(validKey("dGhlIHNhbXBsZSBub25jZQ=="));
  assert.ok(!validKey("short") && !validKey(undefined));
});

test("frames round-trip at every length class, masked or not, even split into single bytes", () => {
  for (const size of [0, 1, 125, 126, 65535, 65536, 70000]) {
    for (const masked of [false, true]) {
      const payload = Buffer.alloc(size, 7);
      const parser = new FrameParser(1 << 20, masked);
      const wire = encodeFrame(OP.text, payload, masked);
      const step = size > 126 ? 997 : 1; // single bytes for the small ones; the big ones in odd-sized chunks
      const frames: ReturnType<FrameParser["push"]> = [];
      for (let i = 0; i < wire.length; i += step) frames.push(...parser.push(wire.subarray(i, i + step)));
      assert.equal(frames.length, 1, `${size} ${masked}`);
      assert.deepEqual(frames[0]!.payload, payload);
    }
  }
});

test("the parser rejects oversized, unmasked, fragmented and long control frames", () => {
  const code = (fn: () => unknown) => {
    try {
      fn();
    } catch (e) {
      return (e as WsError).code;
    }
  };
  assert.equal(code(() => new FrameParser(10, true).push(encodeFrame(OP.text, Buffer.alloc(11), true))), CLOSE.tooBig);
  assert.equal(code(() => new FrameParser(10, true).push(encodeFrame(OP.text, Buffer.alloc(1), false))), CLOSE.protocol);
  assert.equal(code(() => new FrameParser(10, false).push(Buffer.from([OP.text, 0]))), CLOSE.protocol, "fin bit clear");
  assert.equal(code(() => new FrameParser(1000, false).push(encodeFrame(OP.ping, Buffer.alloc(126)))), CLOSE.protocol);
  const huge = Buffer.concat([Buffer.from([0x81, 127]), Buffer.alloc(8, 0xff)]);
  assert.equal(code(() => new FrameParser(1000, false).push(huge)), CLOSE.tooBig, "a 64-bit length is not allocated");
});
