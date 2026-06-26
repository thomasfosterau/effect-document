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

/** Decompress one raw Snappy block. */
export const decompressBlock = (input: Uint8Array): Uint8Array => {
  let pos = 0;

  // Preamble: little-endian varint of the uncompressed length.
  let outLen = 0;
  let shift = 0;
  for (;;) {
    const b = input[pos++]!;
    outLen += (b & 0x7f) * 2 ** shift;
    if ((b & 0x80) === 0) break;
    shift += 7;
  }

  const out = new Uint8Array(outLen);
  let o = 0;

  while (pos < input.length) {
    const tag = input[pos++]!;
    switch (tag & 0x03) {
      case 0: {
        // Literal
        let len = tag >> 2;
        if (len < 60) {
          len += 1;
        } else {
          const n = len - 59; // 60..63 -> 1..4 extra length bytes
          let v = 0;
          for (let i = 0; i < n; i++) v += input[pos++]! * 2 ** (8 * i);
          len = v + 1;
        }
        out.set(input.subarray(pos, pos + len), o);
        pos += len;
        o += len;
        break;
      }
      case 1: {
        // Copy, 1-byte offset
        const len = ((tag >> 2) & 0x07) + 4;
        const offset = ((tag >> 5) << 8) + input[pos++]!;
        let s = o - offset;
        for (let i = 0; i < len; i++) out[o++] = out[s++]!;
        break;
      }
      case 2: {
        // Copy, 2-byte offset
        const len = (tag >> 2) + 1;
        const offset = input[pos++]! + input[pos++]! * 256;
        let s = o - offset;
        for (let i = 0; i < len; i++) out[o++] = out[s++]!;
        break;
      }
      default: {
        // Copy, 4-byte offset
        const len = (tag >> 2) + 1;
        const offset =
          input[pos++]! + input[pos++]! * 256 + input[pos++]! * 65536 + input[pos++]! * 16777216;
        let s = o - offset;
        for (let i = 0; i < len; i++) out[o++] = out[s++]!;
        break;
      }
    }
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
