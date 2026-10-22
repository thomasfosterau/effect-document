/**
 * IWA chunk framing.
 *
 * An `.iwa` file is a sequence of contiguous chunks; each chunk is a 4-byte
 * header `[0x00][3-byte little-endian length]` followed by `length` bytes of a
 * raw Snappy block. Decompressing every chunk and concatenating the results
 * yields the Protobuf object stream (objects may span chunk boundaries).
 */

import { Binary, Parser, Token } from "@thomasfosterau/effect-parse";
import * as Result from "effect/Result";
import { fromParseError, isIworkError, shiftOffset } from "./errors.ts";
import { compressBlock, DEFAULT_MAX_BLOCK_LENGTH, decompressBlock } from "./snappy.ts";

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

/** One chunk: a 0x00 type byte, a 3-byte little-endian length, then that many bytes. */
const chunkBody = Parser.preceded(
  Token.literal(new Uint8Array([0x00])).pipe(Parser.expected("chunk type 0x00")),
  Parser.cut(Binary.lengthTake(Binary.leU24)),
).pipe(Parser.context("IWA chunk"));

const chunks = Parser.compile(Parser.repeat(chunkBody));

export interface DechunkOptions {
  /**
   * The most decompressed bytes one `.iwa` may produce, across all its chunks.
   * Defaults to {@link DEFAULT_MAX_STREAM_LENGTH}.
   */
  readonly maxLength?: number | undefined;
}

/** The default {@link DechunkOptions.maxLength}: 256 MiB. */
export const DEFAULT_MAX_STREAM_LENGTH = 256 * 1024 * 1024;

/**
 * Decode an `.iwa` file into its concatenated, decompressed Protobuf stream.
 * Throws an `IworkError` on a bad chunk header, a truncated chunk or a bad
 * Snappy block, with the offset in the `.iwa` file.
 */
export const dechunk = (data: Uint8Array, options?: DechunkOptions): Uint8Array => {
  const maxLength = options?.maxLength ?? DEFAULT_MAX_STREAM_LENGTH;
  const parsed = Parser.parse(chunks, data);
  if (Result.isFailure(parsed)) throw fromParseError(parsed.failure);
  const blocks: Uint8Array[] = [];
  let total = 0;
  for (const block of parsed.success) {
    // each block is a view into `data`, so its offset is recoverable for errors;
    // the block limit shrinks as the stream fills, capping the whole stream
    const at = block.byteOffset - data.byteOffset;
    let out: Uint8Array;
    try {
      out = decompressBlock(block, {
        maxLength: Math.min(DEFAULT_MAX_BLOCK_LENGTH, maxLength - total),
      });
    } catch (e) {
      throw isIworkError(e) ? shiftOffset(e, at) : e;
    }
    total += out.length;
    blocks.push(out);
  }
  return concat(blocks);
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
