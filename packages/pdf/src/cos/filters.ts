/**
 * Stream filters (ISO 32000-2 §7.4): FlateDecode (with PNG and TIFF
 * predictors), LZWDecode, ASCIIHexDecode, ASCII85Decode and RunLengthDecode.
 *
 * Image-only codecs (DCTDecode, JPXDecode, CCITTFaxDecode, JBIG2Decode) are not
 * decoded: `decodeStream` stops at the first one and returns the data still in
 * that encoding, reporting the filter it stopped at.
 */

import * as Result from "effect/Result";
import * as Predicate from "effect/Predicate";
import * as Match from "effect/Match";
import * as Schema from "effect/Schema";
import * as Arr from "effect/Array";
import { inflateSync, unzlibSync, zlibSync } from "fflate";
import { type PdfDict, type PdfName, type PdfObject, isArray, isDict, isName } from "./objects.ts";

/** A stream could not be decoded: the filter that failed and why. */
export class PdfFilterError extends Schema.TaggedError<PdfFilterError>()("PdfFilterError", {
  filter: Schema.String,
  reason: Schema.String,
}) {
  override get message(): string {
    return `${this.filter}: ${this.reason}`;
  }
}

/** Filters whose output is an encoded image, left for the caller. */
export const IMAGE_FILTERS = new Set([
  "DCTDecode",
  "DCT",
  "JPXDecode",
  "CCITTFaxDecode",
  "CCF",
  "JBIG2Decode",
]);

const num = (dict: PdfDict | undefined, key: string, fallback: number): number => {
  const v = dict?.entries.get(key);
  return Predicate.isNumber(v) ? v : fallback;
};

// ============================================================================
// Flate
// ============================================================================

const flateDecode = (data: Uint8Array): Uint8Array =>
  // a bad zlib header or checksum is common; fall back to the raw deflate data
  Result.try(() => unzlibSync(data)).pipe(
    Result.orElse(() => Result.try(() => inflateSync(data.subarray(2)))),
    Result.orElse(() => Result.try(() => inflateSync(data))),
    Result.getOrThrowWith(
      (cause) =>
        new PdfFilterError({ filter: "FlateDecode", reason: `corrupt data (${String(cause)})` }),
    ),
  );

/** Deflate data for a FlateDecode stream. */
export const flateEncode = (data: Uint8Array): Uint8Array => zlibSync(data);

/** Undo a PNG (10-15) or TIFF (2) predictor. */
/** The PNG predictor's addend for one byte (types 1–4; 0 for None and unknown types). */
const pngDelta = (type: number, left: number, up: number, upLeft: number): number => {
  if (type === 1) return left;
  if (type === 2) return up;
  if (type === 3) return (left + up) >> 1;
  if (type !== 4) return 0;
  // Paeth
  const p = left + up - upLeft;
  const pa = Math.abs(p - left);
  const pb = Math.abs(p - up);
  const pc = Math.abs(p - upLeft);
  return pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
};

/** TIFF predictor 2 on 8-bit components: each byte adds the one `bpp` before it. */
const tiffUnpredict = (data: Uint8Array, bpp: number, rowLength: number): Uint8Array => {
  const out = data.slice();
  for (let row = 0; row + rowLength <= out.length; row += rowLength) {
    for (let i = bpp; i < rowLength; i++)
      out[row + i] = (out[row + i]! + out[row + i - bpp]!) & 0xff;
  }
  return out;
};

/** PNG predictors (10–15): each row starts with its own predictor type byte. */
const pngUnpredict = (data: Uint8Array, bpp: number, rowLength: number): Uint8Array => {
  const rows = Math.floor(data.length / (rowLength + 1));
  const out = new Uint8Array(rows * rowLength);
  let prev = new Uint8Array(rowLength);
  for (let r = 0; r < rows; r++) {
    const type = data[r * (rowLength + 1)]!;
    const src = data.subarray(r * (rowLength + 1) + 1, (r + 1) * (rowLength + 1));
    const cur = out.subarray(r * rowLength, (r + 1) * rowLength);
    for (let i = 0; i < rowLength; i++) {
      const left = i >= bpp ? cur[i - bpp]! : 0;
      const upLeft = i >= bpp ? prev[i - bpp]! : 0;
      cur[i] = (src[i]! + pngDelta(type, left, prev[i]!, upLeft)) & 0xff;
    }
    prev = cur;
  }
  return out;
};

const unpredict = (data: Uint8Array, parms: PdfDict | undefined): Uint8Array => {
  const predictor = num(parms, "Predictor", 1);
  if (predictor <= 1) return data;
  const colors = num(parms, "Colors", 1);
  const bpc = num(parms, "BitsPerComponent", 8);
  const columns = num(parms, "Columns", 1);
  const bpp = Math.max(1, Math.ceil((colors * bpc) / 8));
  const rowLength = Math.ceil((colors * bpc * columns) / 8);
  if (predictor !== 2) return pngUnpredict(data, bpp, rowLength);
  // sub-byte TIFF prediction is vanishingly rare
  return bpc === 8 ? tiffUnpredict(data, bpp, rowLength) : data;
};

// ============================================================================
// LZW
// ============================================================================

const lzwDecode = (data: Uint8Array, earlyChange: number): Uint8Array => {
  const out: number[] = [];
  let dict: number[][] = [];
  const reset = (): void => {
    dict = [];
    for (let i = 0; i < 256; i++) dict.push([i]);
    dict.push([], []); // 256 clear, 257 end of data
  };
  reset();
  let codeLength = 9;
  let bitBuf = 0;
  let bitCount = 0;
  let prev: number[] | undefined;
  for (let i = 0; i < data.length; i++) {
    bitBuf = ((bitBuf << 8) | data[i]!) >>> 0;
    bitCount += 8;
    while (bitCount >= codeLength) {
      const code = (bitBuf >>> (bitCount - codeLength)) & ((1 << codeLength) - 1);
      bitCount -= codeLength;
      bitBuf &= (1 << bitCount) - 1;
      if (code === 256) {
        reset();
        codeLength = 9;
        prev = undefined;
        continue;
      }
      if (code === 257) return Uint8Array.from(out);
      let entry: number[];
      if (code < dict.length) entry = dict[code]!;
      else if (prev !== undefined) entry = [...prev, prev[0]!];
      else throw new PdfFilterError({ filter: "LZWDecode", reason: `invalid code ${code}` });
      out.push(...entry);
      if (prev !== undefined) dict.push([...prev, entry[0]!]);
      prev = entry;
      const next = dict.length + earlyChange;
      if (next >= 1 << codeLength && codeLength < 12) codeLength++;
    }
  }
  return Uint8Array.from(out);
};

// ============================================================================
// ASCII filters and RunLength
// ============================================================================

const asciiHexDecode = (data: Uint8Array): Uint8Array => {
  const out: number[] = [];
  let hi = -1;
  for (const c of data) {
    if (c === 0x3e) break;
    const v =
      c >= 0x30 && c <= 0x39
        ? c - 0x30
        : c >= 0x41 && c <= 0x46
          ? c - 0x37
          : c >= 0x61 && c <= 0x66
            ? c - 0x57
            : -1;
    if (v < 0) continue;
    if (hi < 0) hi = v;
    else {
      out.push(hi * 16 + v);
      hi = -1;
    }
  }
  if (hi >= 0) out.push(hi * 16);
  return Uint8Array.from(out);
};

const ascii85Decode = (data: Uint8Array): Uint8Array => {
  const out: number[] = [];
  const group: number[] = [];
  let i = 0;
  if (data[0] === 0x3c && data[1] === 0x7e) i = 2; // optional <~
  for (; i < data.length; i++) {
    const c = data[i]!;
    if (c === 0x7e) break; // ~>
    if (c === 0x7a && Arr.isReadonlyArrayEmpty(group)) {
      out.push(0, 0, 0, 0);
      continue;
    }
    if (c < 0x21 || c > 0x75) continue;
    group.push(c - 0x21);
    if (group.length === 5) {
      let v = 0;
      for (const d of group) v = v * 85 + d;
      out.push((v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff);
      group.length = 0;
    }
  }
  if (group.length > 1) {
    const n = group.length;
    while (group.length < 5) group.push(84);
    let v = 0;
    for (const d of group) v = v * 85 + d;
    const bytes = [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff];
    out.push(...bytes.slice(0, n - 1));
  }
  return Uint8Array.from(out);
};

const runLengthDecode = (data: Uint8Array): Uint8Array => {
  const out: number[] = [];
  let i = 0;
  while (i < data.length) {
    const len = data[i++]!;
    if (len === 128) break;
    if (len < 128) {
      for (let j = 0; j <= len && i < data.length; j++) out.push(data[i++]!);
    } else {
      const b = data[i++];
      if (b === undefined) break;
      for (let j = 0; j < 257 - len; j++) out.push(b);
    }
  }
  return Uint8Array.from(out);
};

// ============================================================================
// Pipeline
// ============================================================================

/** Apply one named filter. */
export const applyFilter = (
  name: string,
  data: Uint8Array,
  parms: PdfDict | undefined,
): Uint8Array => {
  return Match.value(name).pipe(
    Match.when(Match.is("FlateDecode", "Fl"), () => unpredict(flateDecode(data), parms)),
    Match.when(Match.is("LZWDecode", "LZW"), () =>
      unpredict(lzwDecode(data, num(parms, "EarlyChange", 1)), parms),
    ),
    Match.when(Match.is("ASCIIHexDecode", "AHx"), () => asciiHexDecode(data)),
    Match.when(Match.is("ASCII85Decode", "A85"), () => ascii85Decode(data)),
    Match.when(Match.is("RunLengthDecode", "RL"), () => runLengthDecode(data)),
    // only the Identity crypt filter is meaningful without decryption
    Match.when("Crypt", () => data),
    Match.orElse(() => {
      throw new PdfFilterError({ filter: name, reason: "unsupported filter" });
    }),
  );
};

/** The result of decoding a stream. */
export interface Decoded {
  readonly data: Uint8Array;
  /** The image filter decoding stopped at, if any (the data is still in that encoding). */
  readonly imageFilter?: string | undefined;
  /** The `/DecodeParms` of {@link imageFilter}, if it has any (CCITT and JBIG2 settings). */
  readonly imageParms?: PdfDict | undefined;
}

/**
 * Decode a stream's data through its `/Filter` chain. `resolve` dereferences
 * indirect `/Filter` and `/DecodeParms` values.
 */
export const decodeFilters = (
  dict: PdfDict,
  data: Uint8Array,
  resolve: (o: PdfObject | undefined) => PdfObject | undefined = (o) => o,
): Decoded => {
  const filter = resolve(dict.entries.get("Filter") ?? dict.entries.get("F"));
  const parmsObj = resolve(dict.entries.get("DecodeParms") ?? dict.entries.get("DP"));
  const names = isName(filter)
    ? [filter.name]
    : isArray(filter)
      ? filter.items
          .map((f) => resolve(f))
          .filter((n): n is PdfName => isName(n))
          .map((n) => n.name)
      : [];
  const parms = isArray(parmsObj) ? parmsObj.items.map((p) => resolve(p)) : [parmsObj];
  let out = data;
  for (let i = 0; i < names.length; i++) {
    const name = names[i]!;
    const p = parms[i];
    const dict = isDict(p) ? p : undefined;
    if (IMAGE_FILTERS.has(name)) return { data: out, imageFilter: name, imageParms: dict };
    out = applyFilter(name, out, dict);
  }
  return { data: out };
};
