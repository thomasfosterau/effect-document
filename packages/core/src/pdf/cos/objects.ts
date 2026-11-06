/**
 * The PDF object model (the "COS" layer, ISO 32000-2 §7.3).
 *
 * The three scalar types map onto JavaScript values directly - `null`,
 * `boolean` and `number` - and the rest are small tagged records. Strings are
 * kept as raw bytes because a PDF string is a byte sequence whose meaning
 * depends on where it is used (text string, font codes, binary data).
 * Dictionaries keep their entries in a `Map` keyed by the decoded name.
 */

import * as Arr from "effect/Array";
import * as Predicate from "effect/Predicate";
import * as Rec from "effect/Record";
import { makeEntries } from "./entries.ts";

/** A PDF string: raw bytes, remembering whether it was written in hex form. */
export interface PdfString {
  readonly _tag: "String";
  readonly bytes: Uint8Array;
  readonly hex: boolean;
}

/** A PDF name (`/Type`), with `#xx` escapes decoded. */
export interface PdfName {
  readonly _tag: "Name";
  readonly name: string;
}

/** A PDF array. */
export interface PdfArray {
  readonly _tag: "Array";
  readonly items: PdfObject[];
}

/** A PDF dictionary. */
export interface PdfDict {
  readonly _tag: "Dict";
  readonly entries: Map<string, PdfObject>;
}

/** A PDF stream: its dictionary and its raw (still encoded) data. */
export interface PdfStream {
  readonly _tag: "Stream";
  readonly dict: PdfDict;
  readonly data: Uint8Array;
}

/** An indirect reference (`12 0 R`). */
export interface PdfRef {
  readonly _tag: "Ref";
  readonly num: number;
  readonly gen: number;
}

/** Any PDF object. */
export type PdfObject =
  | null
  | boolean
  | number
  | PdfString
  | PdfName
  | PdfArray
  | PdfDict
  | PdfStream
  | PdfRef;

// ============================================================================
// Constructors
// ============================================================================

const latin1 = (s: string): Uint8Array =>
  Uint8Array.from({ length: s.length }, (_, i) => s.charCodeAt(i) & 0xff);

/** A PDF string object from raw bytes, written in hex (`<…>`) when `hex` is set. */
export const pdfString = (bytes: Uint8Array, hex = false): PdfString => ({
  _tag: "String",
  bytes,
  hex,
});

/** A string from a JavaScript string's code units, one byte each (Latin-1). */
export const pdfLatin1 = (s: string): PdfString => pdfString(latin1(s));

/**
 * A text string (§7.9.2.2): PDFDocEncoding-compatible ASCII when it can be,
 * otherwise UTF-16BE with a byte order mark.
 */
export const pdfTextString = (s: string): PdfString => {
  if (/^[\x20-\x7e\t\n\r]*$/.test(s)) return pdfLatin1(s);
  // a byte order mark, then each UTF-16 code unit high byte first
  const utf16 = Uint8Array.from({ length: 2 + s.length * 2 }, (_, i) =>
    i < 2 ? (i === 0 ? 0xfe : 0xff) : (s.charCodeAt((i - 2) >> 1) >> (i % 2 === 0 ? 8 : 0)) & 0xff,
  );
  return pdfString(utf16, true);
};

/** A PDF name object (`/Name`). */
export const pdfName = (name: string): PdfName => ({ _tag: "Name", name });
/** A PDF array object. */
export const pdfArray = (items: PdfObject[]): PdfArray => ({ _tag: "Array", items });
/** An indirect reference (`num gen R`) to object `num`, generation `gen` (default 0). */
export const pdfRef = (num: number, gen = 0): PdfRef => ({ _tag: "Ref", num, gen });

/** A dictionary from a record; `undefined` values are left out. */
export const pdfDict = (
  entries: Record<string, PdfObject | undefined> | Map<string, PdfObject> = {},
): PdfDict => {
  if (Predicate.isMap(entries)) return { _tag: "Dict", entries };
  return {
    _tag: "Dict",
    entries: makeEntries(
      Arr.filter(Rec.toEntries(entries), (e): e is [string, PdfObject] => e[1] !== undefined),
    ),
  };
};

/** A PDF stream object: a dictionary and its (encoded) data. */
export const pdfStream = (dict: PdfDict, data: Uint8Array): PdfStream => ({
  _tag: "Stream",
  dict,
  data,
});

// ============================================================================
// Guards
// ============================================================================

/** Whether an object is a PDF string. */
export const isString = (o: PdfObject | undefined): o is PdfString =>
  Predicate.isTagged(o, "String");
/** Whether an object is a PDF name, and (when given) that name. */
export const isName = (o: PdfObject | undefined, name?: string): o is PdfName =>
  Predicate.isTagged(o, "Name") && (name === undefined || o.name === name);
/** Whether an object is a PDF array. */
export const isArray = (o: PdfObject | undefined): o is PdfArray => Predicate.isTagged(o, "Array");
/** Whether an object is a PDF dictionary. */
export const isDict = (o: PdfObject | undefined): o is PdfDict => Predicate.isTagged(o, "Dict");
/** Whether an object is a PDF stream. */
export const isStream = (o: PdfObject | undefined): o is PdfStream =>
  Predicate.isTagged(o, "Stream");
/** Whether an object is an indirect reference. */
export const isRef = (o: PdfObject | undefined): o is PdfRef => Predicate.isTagged(o, "Ref");

/** The dictionary of a dictionary or a stream. */
export const dictOf = (o: PdfObject | undefined): PdfDict | undefined =>
  isDict(o) ? o : isStream(o) ? o.dict : undefined;

const LATIN1_CHUNK = 0x2000;

/** Decode a string's bytes one byte per character (Latin-1). */
export const bytesToLatin1 = (bytes: Uint8Array): string =>
  // in chunks, to stay under the engine's limit on spread arguments
  Arr.makeBy(Math.ceil(bytes.length / LATIN1_CHUNK), (k) =>
    String.fromCharCode(...bytes.subarray(k * LATIN1_CHUNK, (k + 1) * LATIN1_CHUNK)),
  ).join("");

/** A string's characters as bytes, one byte per character (Latin-1; higher code points are truncated). */
export const latin1ToBytes = latin1;
