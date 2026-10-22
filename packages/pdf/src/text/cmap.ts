/**
 * CMaps (ISO 32000-2 §9.7.5, §9.10.3): the code space that splits a string's
 * bytes into character codes, the code-to-CID mapping of a Type 0 font's
 * encoding, and the code-to-Unicode mapping of a `/ToUnicode` CMap.
 */

import { Lexer } from "../cos/parser.ts";
import { type PdfObject, isName, isString } from "../cos/objects.ts";

interface Range<V> {
  readonly len: number;
  readonly lo: number;
  readonly hi: number;
  readonly value: V;
}

const bytesToCode = (bytes: Uint8Array): number => {
  let v = 0;
  for (const b of bytes) v = v * 256 + b;
  return v;
};

const utf16 = (bytes: Uint8Array): string => {
  let s = "";
  for (let i = 0; i + 1 < bytes.length; i += 2) s += String.fromCharCode((bytes[i]! << 8) | bytes[i + 1]!);
  if (bytes.length % 2 === 1) s += String.fromCharCode(bytes[bytes.length - 1]!);
  return s;
};

const key = (code: number, len: number): number => code * 4 + (len - 1);

/** A parsed CMap. */
export class CMap {
  /** Code space ranges: which byte lengths make a code. */
  readonly codespaces: Array<Range<null>> = [];
  private readonly unicode = new Map<number, string>();
  private readonly unicodeRanges: Array<Range<{ readonly base: Uint8Array } | ReadonlyArray<string>>> = [];
  private readonly cids = new Map<number, number>();
  private readonly cidRanges: Array<Range<number>> = [];
  /** The CMap this one extends (`usecmap`), by name. */
  parent?: string | undefined;
  /** Vertical writing mode (`/WMode 1`). */
  vertical = false;

  /** Split a string into character codes using the code space ranges. */
  codes(bytes: Uint8Array, fallbackLength = 1): Array<{ readonly code: number; readonly len: number }> {
    const out: Array<{ code: number; len: number }> = [];
    const spaces = this.codespaces;
    let pos = 0;
    while (pos < bytes.length) {
      let matched = 0;
      let code = 0;
      for (let len = 1; len <= 4 && pos + len <= bytes.length; len++) {
        code = code * 256 + bytes[pos + len - 1]!;
        if (spaces.some((s) => s.len === len && code >= s.lo && code <= s.hi)) {
          matched = len;
          break;
        }
      }
      const len = matched || (spaces.length > 0 ? Math.min(...spaces.map((s) => s.len)) : fallbackLength);
      const n = Math.min(len, bytes.length - pos);
      out.push({ code: bytesToCode(bytes.subarray(pos, pos + n)), len: n });
      pos += n;
    }
    return out;
  }

  /** The Unicode text for a code, if the CMap maps it. */
  toUnicode(code: number, len: number): string | undefined {
    const direct = this.unicode.get(key(code, len));
    if (direct !== undefined) return direct;
    for (const r of this.unicodeRanges) {
      if (r.len !== len || code < r.lo || code > r.hi) continue;
      if (Array.isArray(r.value)) return (r.value as ReadonlyArray<string>)[code - r.lo];
      return incremented((r.value as { base: Uint8Array }).base, code - r.lo);
    }
    return undefined;
  }

  /** The CID for a code, if the CMap maps it. */
  toCid(code: number, len: number): number | undefined {
    const direct = this.cids.get(key(code, len));
    if (direct !== undefined) return direct;
    for (const r of this.cidRanges) if (r.len === len && code >= r.lo && code <= r.hi) return r.value + (code - r.lo);
    return undefined;
  }

  /** Whether the CMap maps any code to Unicode. */
  get hasUnicode(): boolean {
    return this.unicode.size > 0 || this.unicodeRanges.length > 0;
  }

  addCodespace(lo: Uint8Array, hi: Uint8Array): void {
    this.codespaces.push({ len: lo.length, lo: bytesToCode(lo), hi: bytesToCode(hi), value: null });
  }

  addUnicode(src: Uint8Array, dst: string): void {
    this.unicode.set(key(bytesToCode(src), src.length), dst);
  }

  addUnicodeRange(lo: Uint8Array, hi: Uint8Array, dst: Uint8Array | ReadonlyArray<string>): void {
    const l = bytesToCode(lo);
    const h = bytesToCode(hi);
    if (h < l) return;
    if (dst instanceof Uint8Array && h - l < 256) {
      for (let c = l; c <= h; c++) this.unicode.set(key(c, lo.length), incremented(dst, c - l));
      return;
    }
    this.unicodeRanges.push({ len: lo.length, lo: l, hi: h, value: dst instanceof Uint8Array ? { base: dst } : dst });
  }

  addCid(src: Uint8Array, cid: number): void {
    this.cids.set(key(bytesToCode(src), src.length), cid);
  }

  addCidRange(lo: Uint8Array, hi: Uint8Array, cid: number): void {
    this.cidRanges.push({ len: lo.length, lo: bytesToCode(lo), hi: bytesToCode(hi), value: cid });
  }
}

/** A bfrange destination: the base string with its last byte(s) incremented. */
const incremented = (base: Uint8Array, by: number): string => {
  if (by === 0) return utf16(base);
  const out = base.slice();
  let carry = by;
  for (let i = out.length - 1; i >= 0 && carry > 0; i--) {
    const v = out[i]! + carry;
    out[i] = v & 0xff;
    carry = v >> 8;
  }
  return utf16(out);
};

const dstString = (o: PdfObject | undefined, glyphName: (name: string) => string | undefined): string | undefined =>
  isString(o) ? utf16(o.bytes) : isName(o) ? glyphName(o.name) : undefined;

/** Parse a CMap program (the decoded data of a CMap stream). */
export const parseCMap = (data: Uint8Array, glyphName: (name: string) => string | undefined = () => undefined): CMap => {
  const cmap = new CMap();
  const lexer = new Lexer(data);
  const operands: PdfObject[] = [];
  let section: string | undefined;
  for (;;) {
    const t = lexer.next();
    if (t.kind === "eof") break;
    if (t.kind === "value") {
      operands.push(t.value);
      if (section !== undefined) consume(cmap, section, operands, glyphName);
      else if (operands.length > 3) operands.shift();
      continue;
    }
    if (t.kind === "punct") {
      if (t.char === "[" && section === "bfrange") {
        // an array of destination strings
        const items: string[] = [];
        for (;;) {
          const x = lexer.next();
          if (x.kind === "eof" || (x.kind === "punct" && x.char === "]")) break;
          if (x.kind === "value") items.push(dstString(x.value, glyphName) ?? "");
        }
        const [lo, hi] = operands.splice(0, 2);
        if (isString(lo) && isString(hi)) cmap.addUnicodeRange(lo.bytes, hi.bytes, items);
      }
      continue;
    }
    const word = t.word;
    if (word.startsWith("begin") && word.length > 5 && word !== "begincmap") {
      section = word.slice(5);
      operands.length = 0;
      continue;
    }
    if (word.startsWith("end") && word !== "endcmap" && word !== "end") {
      section = undefined;
      operands.length = 0;
      continue;
    }
    if (word === "usecmap") {
      const parent = operands[operands.length - 1];
      if (isName(parent)) cmap.parent = parent.name;
      operands.length = 0;
      continue;
    }
    if (word === "def") {
      const [k, v] = operands.slice(-2);
      if (isName(k, "WMode") && v === 1) cmap.vertical = true;
      operands.length = 0;
      continue;
    }
    operands.length = 0;
  }
  return cmap;
};

/** Apply a section's operands as soon as an entry is complete. */
const consume = (cmap: CMap, section: string, operands: PdfObject[], glyphName: (name: string) => string | undefined): void => {
  switch (section) {
    case "codespacerange":
      while (operands.length >= 2) {
        const [lo, hi] = operands.splice(0, 2);
        if (isString(lo) && isString(hi)) cmap.addCodespace(lo.bytes, hi.bytes);
      }
      break;
    case "bfchar":
      while (operands.length >= 2) {
        const [src, dst] = operands.splice(0, 2);
        const s = dstString(dst, glyphName);
        if (isString(src) && s !== undefined) cmap.addUnicode(src.bytes, s);
      }
      break;
    case "bfrange":
      while (operands.length >= 3) {
        const [lo, hi, dst] = operands.splice(0, 3);
        if (isString(lo) && isString(hi) && isString(dst)) cmap.addUnicodeRange(lo.bytes, hi.bytes, dst.bytes);
      }
      break;
    case "cidchar":
    case "notdefchar":
      while (operands.length >= 2) {
        const [src, cid] = operands.splice(0, 2);
        if (isString(src) && typeof cid === "number" && section === "cidchar") cmap.addCid(src.bytes, cid);
      }
      break;
    case "cidrange":
    case "notdefrange":
      while (operands.length >= 3) {
        const [lo, hi, cid] = operands.splice(0, 3);
        if (isString(lo) && isString(hi) && typeof cid === "number" && section === "cidrange") cmap.addCidRange(lo.bytes, hi.bytes, cid);
      }
      break;
    default:
      operands.length = 0;
  }
};

