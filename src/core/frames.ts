// Ported from Heeler's herdr-plugin helper (Apache-2.0,
// ~/Codex/heeler/plugin/helper/core/frames.js), which pins this codec against
// captured wire vectors in plugin/test-vectors/herdr-core-frames-v1.json.
//
// herdr-core speaks framed protocol: a plain `hello` line, then frames of
// channel (u32 LE), kind (u8), length (u32 LE) and payload.

const HEADER_LENGTH = 9;
const MAXIMUM_PAYLOAD = 16 * 1024 * 1024;

export const INITIAL_CREDIT = 256 * 1024;

export const FRAME_KIND = Object.freeze({
  data: 0,
  credit: 1,
  close: 2,
  resize: 3,
  focus: 4,
  facts: 5,
} as const);

const KNOWN_KINDS = new Set<number>(Object.values(FRAME_KIND));

export interface Frame {
  channel: number;
  kind: number;
  payload: Buffer;
}

export function encodeFrame({ channel, kind, payload = Buffer.alloc(0) }: Frame): Buffer {
  if (payload.length > MAXIMUM_PAYLOAD) throw new Error("A frame's payload exceeds 16 MiB.");
  const header = Buffer.alloc(HEADER_LENGTH);
  header.writeUInt32LE(channel, 0);
  header.writeUInt8(kind, 4);
  header.writeUInt32LE(payload.length, 5);
  return Buffer.concat([header, payload]);
}

/** Grants a stream `bytes` more of DATA payload. */
export function creditFrame(channel: number, bytes: number): Buffer {
  const payload = Buffer.alloc(4);
  payload.writeUInt32LE(bytes, 0);
  return encodeFrame({ channel, kind: FRAME_KIND.credit, payload });
}

/** One channel-0 request. Frames delimit its message, so it has no newline. */
export function requestFrame(id: string, method: string, params: unknown = {}): Buffer {
  const payload = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id, method, params }), "utf8");
  return encodeFrame({ channel: 0, kind: FRAME_KIND.data, payload });
}

/**
 * The plain line that switches a connection to frames. It never carries a
 * `core` field, which would register the connection as a peer core.
 */
export function helloLine(): Buffer {
  const request = {
    jsonrpc: "2.0",
    id: "hello",
    method: "hello",
    params: { generation: 1, framed: true },
  };
  return Buffer.from(`${JSON.stringify(request)}\n`, "utf8");
}

/**
 * Splits a byte stream into frames. A header announcing more than the limit is
 * refused as soon as it is complete, and the refusal sticks: nothing after it
 * can be trusted to be a frame.
 */
export class FrameDecoder {
  #chunks: Buffer[] = [];
  #length = 0;
  #needed = HEADER_LENGTH;
  #refusal: Error | null = null;

  get bufferedByteCount(): number {
    return this.#length;
  }

  append(bytes: Buffer): void {
    if (this.#refusal !== null) return;
    this.#chunks.push(bytes);
    this.#length += bytes.length;
  }

  /** The next complete frame of a known kind, or null until more bytes arrive. */
  next(): Frame | null {
    if (this.#refusal !== null) throw this.#refusal;
    while (this.#length >= this.#needed) {
      const buffered = this.#chunks.length === 1 ? this.#chunks[0]! : Buffer.concat(this.#chunks);
      const length = buffered.readUInt32LE(5);
      if (length > MAXIMUM_PAYLOAD) {
        this.#chunks = [];
        this.#length = 0;
        this.#refusal = new Error(`A frame announces ${length} bytes, over the 16 MiB limit.`);
        throw this.#refusal;
      }
      const frameLength = HEADER_LENGTH + length;
      if (buffered.length < frameLength) {
        this.#chunks = [buffered];
        this.#needed = frameLength;
        return null;
      }
      const rest = buffered.subarray(frameLength);
      this.#chunks = rest.length > 0 ? [rest] : [];
      this.#length = rest.length;
      this.#needed = HEADER_LENGTH;
      const kind = buffered.readUInt8(4);
      if (KNOWN_KINDS.has(kind)) {
        return {
          channel: buffered.readUInt32LE(0),
          kind,
          payload: buffered.subarray(HEADER_LENGTH, frameLength),
        };
      }
    }
    return null;
  }
}
