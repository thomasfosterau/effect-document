/**
 * Writing PDF objects and files (ISO 32000-2 §7.3, §7.5).
 *
 * `serializeObject` renders one object; `PdfBuilder` assembles a whole file -
 * numbered indirect objects, a classic cross-reference table and a trailer -
 * and `rewritePdf` saves a `PdfFile` back out (with any edits made to its
 * objects), expanding object streams into plain objects.
 */

import type { PdfFile } from "./file.ts";
import { flateEncode } from "./filters.ts";
import {
  type PdfObject,
  type PdfRef,
  type PdfStream,
  isName,
  isRef,
  isStream,
  latin1ToBytes,
  pdfArray,
  pdfDict,
  pdfName,
  pdfRef,
  pdfStream,
  pdfString,
} from "./objects.ts";

const NAME_SAFE = /^[!-~]$/;
const NAME_ESCAPE = new Set("()<>[]{}/%#");

const formatNumber = (n: number): string => {
  if (!Number.isFinite(n)) return "0";
  if (Number.isInteger(n)) return String(n);
  const s = n.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
  return s === "-0" ? "0" : s;
};

const formatName = (name: string): string => {
  let out = "/";
  for (const ch of name) {
    const code = ch.charCodeAt(0);
    if (code <= 0xff && NAME_SAFE.test(ch) && !NAME_ESCAPE.has(ch)) out += ch;
    else
      for (const b of code <= 0xff ? [code] : new TextEncoder().encode(ch))
        out += "#" + b.toString(16).padStart(2, "0").toUpperCase();
  }
  return out;
};

const formatString = (bytes: Uint8Array, hex: boolean): string => {
  if (hex) {
    let out = "<";
    for (const b of bytes) out += b.toString(16).padStart(2, "0");
    return out + ">";
  }
  let out = "(";
  for (const b of bytes) {
    if (b === 0x28 || b === 0x29 || b === 0x5c) out += "\\" + String.fromCharCode(b);
    else if (b === 0x0d) out += "\\r";
    else if (b === 0x0a) out += "\\n";
    else if (b >= 0x20 && b < 0x7f) out += String.fromCharCode(b);
    else out += "\\" + b.toString(8).padStart(3, "0");
  }
  return out + ")";
};

/** Render an object as PDF syntax. Streams render their dictionary and raw data. */
export const serializeObject = (o: PdfObject): Uint8Array => {
  const chunks: Uint8Array[] = [];
  let text = "";
  const flush = (): void => {
    if (text !== "") chunks.push(latin1ToBytes(text));
    text = "";
  };
  const write = (x: PdfObject): void => {
    if (x === null) text += "null";
    else if (typeof x === "boolean") text += x ? "true" : "false";
    else if (typeof x === "number") text += formatNumber(x);
    else {
      switch (x._tag) {
        case "Name":
          text += formatName(x.name);
          break;
        case "String":
          text += formatString(x.bytes, x.hex);
          break;
        case "Ref":
          text += `${x.num} ${x.gen} R`;
          break;
        case "Array":
          text += "[";
          x.items.forEach((item, i) => {
            if (i > 0) text += " ";
            write(item);
          });
          text += "]";
          break;
        case "Dict":
          text += "<<";
          for (const [k, v] of x.entries) {
            text += formatName(k) + " ";
            write(v);
            text += " ";
          }
          text += ">>";
          break;
        case "Stream": {
          const entries = new Map(x.dict.entries);
          entries.set("Length", x.data.length);
          write(pdfDict(entries));
          text += "\nstream\n";
          flush();
          chunks.push(x.data);
          text += "\nendstream";
          break;
        }
      }
    }
  };
  write(o);
  flush();
  return concat(chunks);
};

const concat = (chunks: ReadonlyArray<Uint8Array>): Uint8Array => {
  let length = 0;
  for (const c of chunks) length += c.length;
  const out = new Uint8Array(length);
  let pos = 0;
  for (const c of chunks) {
    out.set(c, pos);
    pos += c.length;
  }
  return out;
};

/** A stream whose data is Flate-compressed (unless compression would not help). */
export const flateStream = (
  data: Uint8Array,
  entries: Record<string, PdfObject | undefined> = {},
): PdfStream => {
  const compressed = flateEncode(data);
  if (compressed.length >= data.length) return pdfStream(pdfDict(entries), data);
  return pdfStream(pdfDict({ ...entries, Filter: pdfName("FlateDecode") }), compressed);
};

/** Options for the file trailer. */
export interface TrailerOptions {
  /** The document catalog. */
  readonly root: PdfRef;
  /** The document information dictionary. */
  readonly info?: PdfRef | undefined;
  /** Extra trailer entries (e.g. `/ID`, `/Encrypt`). */
  readonly extra?: Record<string, PdfObject> | undefined;
  /** The header version (default `1.7`). */
  readonly version?: string | undefined;
}

/**
 * Write a complete file from numbered objects: header, objects in number
 * order, a cross-reference table and the trailer.
 */
export const serializeFile = (
  objects: ReadonlyMap<number, { readonly object: PdfObject; readonly gen?: number }>,
  options: TrailerOptions,
): Uint8Array => {
  const chunks: Uint8Array[] = [];
  let pos = 0;
  const push = (b: Uint8Array): void => {
    chunks.push(b);
    pos += b.length;
  };
  // the binary comment marks the file as binary for transfer tools
  push(latin1ToBytes(`%PDF-${options.version ?? "1.7"}\n%\xe2\xe3\xcf\xd3\n`));

  const nums = [...objects.keys()].sort((a, b) => a - b);
  const size = (nums[nums.length - 1] ?? 0) + 1;
  const offsets = new Map<number, { offset: number; gen: number }>();
  for (const num of nums) {
    const { object, gen = 0 } = objects.get(num)!;
    offsets.set(num, { offset: pos, gen });
    push(latin1ToBytes(`${num} ${gen} obj\n`));
    push(serializeObject(object));
    push(latin1ToBytes("\nendobj\n"));
  }

  const xrefAt = pos;
  let xref = `xref\n0 ${size}\n0000000000 65535 f\r\n`;
  for (let n = 1; n < size; n++) {
    const e = offsets.get(n);
    xref +=
      e === undefined
        ? "0000000000 65535 f\r\n"
        : `${String(e.offset).padStart(10, "0")} ${String(e.gen).padStart(5, "0")} n\r\n`;
  }
  push(latin1ToBytes(xref));
  const trailer = pdfDict({ Size: size, Root: options.root, Info: options.info, ...options.extra });
  push(latin1ToBytes("trailer\n"));
  push(serializeObject(trailer));
  push(latin1ToBytes(`\nstartxref\n${xrefAt}\n%%EOF\n`));
  return concat(chunks);
};

/** Assembles a new PDF file from indirect objects. */
export class PdfBuilder {
  private readonly objects = new Map<number, { object: PdfObject }>();
  private next = 1;

  /** Reserve an object number, to be filled with `set`. */
  alloc(): PdfRef {
    return pdfRef(this.next++);
  }

  /** Add an indirect object, returning its reference. */
  add(object: PdfObject): PdfRef {
    const ref = this.alloc();
    this.set(ref, object);
    return ref;
  }

  /** Set (or replace) the object a reference points at. */
  set(ref: PdfRef, object: PdfObject): void {
    this.objects.set(ref.num, { object });
  }

  /** Render the file. Every allocated number must have been set. */
  build(options: TrailerOptions): Uint8Array {
    return serializeFile(this.objects, options);
  }
}

/** A trailer `/ID`: two copies of a 16-byte identifier derived from `seed`. */
export const fileId = (seed: Uint8Array): PdfObject => {
  // FNV-1a over the seed, stretched to 16 bytes; uniqueness, not secrecy, is the point
  const id = new Uint8Array(16);
  let h = 0x811c9dc5;
  for (let i = 0; i < 16; i++) {
    for (let j = i; j < seed.length; j += 16) h = Math.imul(h ^ seed[j]!, 0x01000193) >>> 0;
    h = Math.imul(h ^ i, 0x01000193) >>> 0;
    id[i] = h & 0xff;
  }
  return pdfArray([pdfString(id, true), pdfString(id, true)]);
};

/**
 * Save a parsed file as a new, self-contained PDF: every object keeps its
 * number, members of object streams become plain objects, and the
 * cross-reference streams and object streams themselves are dropped.
 * `overrides` replaces (or, with `null`, deletes) objects by number.
 *
 * Encrypted files are refused: their objects can't be moved out of object
 * streams without decrypting them.
 */
export const rewritePdf = (
  file: PdfFile,
  overrides: ReadonlyMap<number, PdfObject> = new Map(),
): Uint8Array => {
  if (file.encrypted) throw new Error("rewritePdf: encrypted files are not supported");
  const objects = new Map<number, { object: PdfObject; gen: number }>();
  for (const num of file.objectNumbers()) {
    if (num === 0) continue;
    const e = file.entry(num);
    const object = overrides.has(num) ? overrides.get(num)! : file.get(num);
    if (object === null) continue;
    if (
      isStream(object) &&
      (isName(object.dict.entries.get("Type"), "XRef") ||
        isName(object.dict.entries.get("Type"), "ObjStm"))
    )
      continue;
    objects.set(num, { object, gen: e?._tag === "Offset" ? e.gen : 0 });
  }
  for (const [num, object] of overrides) {
    if (!objects.has(num) && object !== null) objects.set(num, { object, gen: 0 });
  }
  // a repaired trailer may hold the catalog or info dictionary directly
  let free = Math.max(0, ...objects.keys()) + 1;
  const indirect = (o: PdfObject | undefined): PdfRef | undefined => {
    if (o === undefined || o === null) return undefined;
    if (isRef(o)) return o;
    const ref = pdfRef(free++);
    objects.set(ref.num, { object: o, gen: 0 });
    return ref;
  };
  const root = indirect(file.trailer.entries.get("Root"))!;
  const info = indirect(file.trailer.entries.get("Info"));
  const id = file.trailer.entries.get("ID");
  return serializeFile(objects, {
    root,
    info,
    extra: id === undefined ? {} : { ID: id },
    version: file.version,
  });
};
