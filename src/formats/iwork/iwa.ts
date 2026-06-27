/**
 * IWA chunk framing.
 *
 * An `.iwa` file is a sequence of contiguous chunks; each chunk is a 4-byte
 * header `[0x00][3-byte little-endian length]` followed by `length` bytes of a
 * raw Snappy block. Decompressing every chunk and concatenating the results
 * yields the Protobuf object stream (objects may span chunk boundaries).
 */

import { compressBlock, decompressBlock } from "./snappy.js";

const concat = (parts: ReadonlyArray<Uint8Array>): Uint8Array => {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};

/** Decode an `.iwa` file into its concatenated, decompressed Protobuf stream. */
export const dechunk = (data: Uint8Array): Uint8Array => {
  const parts: Uint8Array[] = [];
  let pos = 0;
  while (pos < data.length) {
    const type = data[pos]!;
    if (type !== 0x00) {
      throw new Error(`IWA chunk does not start with 0x00 (found ${type})`);
    }
    const len = data[pos + 1]! + data[pos + 2]! * 256 + data[pos + 3]! * 65536;
    parts.push(decompressBlock(data.subarray(pos + 4, pos + 4 + len)));
    pos += 4 + len;
  }
  return concat(parts);
};

/** Encode a Protobuf stream into IWA chunks (64 KiB uncompressed blocks). */
export const chunk = (stream: Uint8Array): Uint8Array => {
  const out: Uint8Array[] = [];
  let pos = 0;
  while (pos < stream.length) {
    const comp = compressBlock(stream.subarray(pos, pos + 65536));
    const header = new Uint8Array(4);
    header[0] = 0x00;
    header[1] = comp.length & 0xff;
    header[2] = (comp.length >> 8) & 0xff;
    header[3] = (comp.length >> 16) & 0xff;
    out.push(header, comp);
    pos += 65536;
  }
  return concat(out);
};
