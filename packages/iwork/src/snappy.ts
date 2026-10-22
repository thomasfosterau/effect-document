/**
 * Snappy *block* format codec (dependency-free).
 *
 * iWork's `.iwa` chunks carry raw Snappy blocks (no stream framing / CRC), so a
 * standard Snappy stream library cannot be used directly. We implement the block
 * format from the spec: a varint preamble (uncompressed length) followed by
 * literal/copy elements.
 *
 * `decompressBlock` handles the full format (including overlapping copies, which
 * are run-length expansion and must be copied one byte at a time).
 * `compressBlock` emits a valid *literals-only* block - never optimal, but fully
 * spec-compliant and accepted by any Snappy decoder (including Apple's), which
 * keeps the encoder trivial.
 */

import { codecError, type IworkError } from "./errors.ts";

export interface DecompressOptions {
  /**
   * The largest uncompressed length a block may declare. A larger preamble
   * fails with `LimitExceeded` before anything is allocated. Defaults to
   * {@link DEFAULT_MAX_BLOCK_LENGTH}.
   */
  readonly maxLength?: number | undefined;
}

/** The default {@link DecompressOptions.maxLength}: 64 MiB. */
export const DEFAULT_MAX_BLOCK_LENGTH = 64 * 1024 * 1024;

/**
 * The most output one input byte can produce: a 3-byte copy with a 2-byte
 * offset writes up to 64 bytes. A preamble claiming more than this ratio of the
 * remaining input cannot be honest.
 */
const MAX_EXPANSION = 64 / 3;

const truncated = (what: string, at: number): IworkError =>
  codecError("Truncated", `snappy: ${what} runs past the end of the block`, at);

/**
 * Decompress one raw Snappy block. Throws an `IworkError` (and nothing else)
 * on malformed input: every length and copy offset is checked, and the output
 * must be exactly the length the preamble declares.
 */
export const decompressBlock = (input: Uint8Array, options?: DecompressOptions): Uint8Array => {
  const maxLength = options?.maxLength ?? DEFAULT_MAX_BLOCK_LENGTH;
  let pos = 0;

  // Preamble: little-endian varint of the uncompressed length (a uint32, so at most 5 bytes).
  let outLen = 0;
  let shift = 0;
  for (;;) {
    if (pos >= input.length) throw truncated("preamble", 0);
    if (shift > 28) throw codecError("Malformed", "snappy: preamble longer than 5 bytes", 0);
    const b = input[pos++]!;
    outLen += (b & 0x7f) * 2 ** shift;
    if ((b & 0x80) === 0) break;
    shift += 7;
  }
  if (outLen > 0xffffffff) throw codecError("Malformed", "snappy: preamble exceeds 32 bits", 0);
  if (outLen > maxLength) {
    throw codecError(
      "LimitExceeded",
      `snappy: block declares ${outLen} bytes, over the ${maxLength}-byte limit`,
      0,
    );
  }
  if (outLen > (input.length - pos) * MAX_EXPANSION) {
    throw codecError(
      "Malformed",
      `snappy: block declares ${outLen} bytes, more than ${input.length - pos} bytes of input can produce`,
      0,
    );
  }

  const out = new Uint8Array(outLen);
  let o = 0;

  /** Copy `len` bytes from `offset` back in the output (overlap is run-length expansion). */
  const copy = (at: number, len: number, offset: number): void => {
    if (offset === 0 || offset > o) {
      throw codecError(
        "Malformed",
        `snappy: copy offset ${offset} is outside the ${o} bytes written`,
        at,
      );
    }
    if (len > outLen - o) {
      throw codecError(
        "Malformed",
        `snappy: copy of ${len} bytes overruns the declared ${outLen}-byte output`,
        at,
      );
    }
    let s = o - offset;
    for (let i = 0; i < len; i++) out[o++] = out[s++]!;
  };

  while (pos < input.length) {
    const at = pos;
    const tag = input[pos++]!;
    switch (tag & 0x03) {
      case 0: {
        // Literal
        let len = tag >> 2;
        if (len < 60) {
          len += 1;
        } else {
          const n = len - 59; // 60..63 -> 1..4 extra length bytes
          if (input.length - pos < n) throw truncated("literal length", at);
          let v = 0;
          for (let i = 0; i < n; i++) v += input[pos++]! * 2 ** (8 * i);
          len = v + 1;
        }
        if (len > input.length - pos) throw truncated(`literal of ${len} bytes`, at);
        if (len > outLen - o) {
          throw codecError(
            "Malformed",
            `snappy: literal of ${len} bytes overruns the declared ${outLen}-byte output`,
            at,
          );
        }
        out.set(input.subarray(pos, pos + len), o);
        pos += len;
        o += len;
        break;
      }
      case 1: {
        // Copy, 1-byte offset
        if (input.length - pos < 1) throw truncated("copy offset", at);
        const len = ((tag >> 2) & 0x07) + 4;
        copy(at, len, ((tag >> 5) << 8) + input[pos++]!);
        break;
      }
      case 2: {
        // Copy, 2-byte offset
        if (input.length - pos < 2) throw truncated("copy offset", at);
        const len = (tag >> 2) + 1;
        copy(at, len, input[pos++]! + input[pos++]! * 256);
        break;
      }
      default: {
        // Copy, 4-byte offset
        if (input.length - pos < 4) throw truncated("copy offset", at);
        const len = (tag >> 2) + 1;
        copy(
          at,
          len,
          input[pos++]! + input[pos++]! * 256 + input[pos++]! * 65536 + input[pos++]! * 16777216,
        );
        break;
      }
    }
  }
  if (o !== outLen) {
    throw codecError(
      "Truncated",
      `snappy: block produced ${o} bytes, the preamble declared ${outLen}`,
      input.length,
    );
  }
  return out;
};

const pushVarint = (out: number[], value: number): void => {
  let v = value;
  do {
    let b = v & 0x7f;
    v = Math.floor(v / 128);
    if (v > 0) b |= 0x80;
    out.push(b);
  } while (v > 0);
};

/** Compress to a valid raw Snappy block using only literal elements. */
export const compressBlock = (input: Uint8Array): Uint8Array => {
  const out: number[] = [];
  pushVarint(out, input.length);

  let pos = 0;
  while (pos < input.length) {
    const len = Math.min(input.length - pos, 65536);
    const ll = len - 1;
    if (ll < 60) {
      out.push((ll << 2) | 0x00);
    } else {
      const nBytes = ll < 256 ? 1 : ll < 65536 ? 2 : ll < 16777216 ? 3 : 4;
      out.push(((59 + nBytes) << 2) | 0x00);
      let v = ll;
      for (let i = 0; i < nBytes; i++) {
        out.push(v & 0xff);
        v = Math.floor(v / 256);
      }
    }
    for (let i = 0; i < len; i++) out.push(input[pos + i]!);
    pos += len;
  }
  return Uint8Array.from(out);
};
