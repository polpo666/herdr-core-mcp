import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { FrameDecoder, FRAME_KIND, helloLine, requestFrame } from "../src/core/frames.js";

interface Vectors {
  hello: { reply: string };
  frames: { name: string; bytes: string }[];
  exchanges: { name: string; method: string; params: unknown; requestFrame: string; replyFrame: string }[];
}

const here = dirname(fileURLToPath(import.meta.url));
const vectors = JSON.parse(readFileSync(join(here, "fixtures", "herdr-core-frames-v1.json"), "utf8")) as Vectors;

test("hello line is a plain newline-terminated JSON-RPC call", () => {
  const line = helloLine().toString("utf8");
  assert.ok(line.endsWith("\n"));
  const request = JSON.parse(line.trimEnd()) as { method: string; params: Record<string, unknown> };
  assert.equal(request.method, "hello");
  assert.equal(request.params.framed, true);
  assert.equal(request.params.generation, 1);
  assert.equal("core" in request.params, false);
});

test("request frames match the captured wire vector", () => {
  const serverStatus = vectors.exchanges.find((exchange) => exchange.name === "server-status");
  assert.ok(serverStatus);
  assert.equal(
    requestFrame("1", serverStatus.method, serverStatus.params).toString("hex"),
    serverStatus.requestFrame,
  );
});

test("the decoder reads captured reply frames", () => {
  const serverStatus = vectors.exchanges.find((exchange) => exchange.name === "server-status");
  assert.ok(serverStatus);
  const decoder = new FrameDecoder();
  decoder.append(Buffer.from(serverStatus.replyFrame, "hex"));
  const frame = decoder.next();
  assert.ok(frame);
  assert.equal(frame.channel, 0);
  assert.equal(frame.kind, FRAME_KIND.data);
  const body = JSON.parse(frame.payload.toString("utf8")) as { id: string; result: { core: { id: string } } };
  assert.equal(body.id, "1");
  assert.equal(body.result.core.id, "scrubbed-core-id");
  assert.equal(decoder.next(), null);
});

test("the decoder reads a split frame only once it is complete", () => {
  const close = vectors.frames.find((frame) => frame.name === "close-from-client");
  assert.ok(close);
  const bytes = Buffer.from(close.bytes, "hex");
  const decoder = new FrameDecoder();
  decoder.append(bytes.subarray(0, 5));
  assert.equal(decoder.next(), null);
  decoder.append(bytes.subarray(5));
  const frame = decoder.next();
  assert.ok(frame);
  assert.equal(frame.kind, FRAME_KIND.close);
  assert.equal(frame.channel, 2);
});
