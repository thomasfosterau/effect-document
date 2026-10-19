/**
 * The PDF object model (the "COS" layer, ISO 32000-2 §7.3).
 *
 * The three scalar types map onto JavaScript values directly - `null`,
 * `boolean` and `number` - and the rest are small tagged records. Strings are
 * kept as raw bytes because a PDF string is a byte sequence whose meaning
 * depends on where it is used (text string, font codes, binary data).
 * Dictionaries keep their entries in a `Map` keyed by the decoded name.
 */

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

const latin1 = (s: string): Uint8Array => {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
};

export const pdfString = (bytes: Uint8Array, hex = false): PdfString => ({ _tag: "String", bytes, hex });

/** A string from a JavaScript string's code units, one byte each (Latin-1). */
export const pdfLatin1 = (s: string): PdfString => pdfString(latin1(s));

/**
 * A text string (§7.9.2.2): PDFDocEncoding-compatible ASCII when it can be,
 * otherwise UTF-16BE with a byte order mark.
 */
export const pdfTextString = (s: string): PdfString => {
  if (/^[\x20-\x7e\t\n\r]*$/.test(s)) return pdfLatin1(s);
  const out = [0xfe, 0xff];
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    out.push(c >> 8, c & 0xff);
  }
  return pdfString(new Uint8Array(out), true);
};

export const pdfName = (name: string): PdfName => ({ _tag: "Name", name });
export const pdfArray = (items: PdfObject[]): PdfArray => ({ _tag: "Array", items });
export const pdfRef = (num: number, gen = 0): PdfRef => ({ _tag: "Ref", num, gen });

/** A dictionary from a record; `undefined` values are left out. */
export const pdfDict = (entries: Record<string, PdfObject | undefined> | Map<string, PdfObject> = {}): PdfDict => {
  if (entries instanceof Map) return { _tag: "Dict", entries };
  const map = new Map<string, PdfObject>();
  for (const [k, v] of Object.entries(entries)) if (v !== undefined) map.set(k, v);
  return { _tag: "Dict", entries: map };
};

export const pdfStream = (dict: PdfDict, data: Uint8Array): PdfStream => ({ _tag: "Stream", dict, data });

// ============================================================================
// Guards
// ============================================================================

export const isString = (o: PdfObject | undefined): o is PdfString =>
  typeof o === "object" && o !== null && o._tag === "String";
export const isName = (o: PdfObject | undefined, name?: string): o is PdfName =>
  typeof o === "object" && o !== null && o._tag === "Name" && (name === undefined || o.name === name);
export const isArray = (o: PdfObject | undefined): o is PdfArray =>
  typeof o === "object" && o !== null && o._tag === "Array";
export const isDict = (o: PdfObject | undefined): o is PdfDict =>
  typeof o === "object" && o !== null && o._tag === "Dict";
export const isStream = (o: PdfObject | undefined): o is PdfStream =>
  typeof o === "object" && o !== null && o._tag === "Stream";
export const isRef = (o: PdfObject | undefined): o is PdfRef =>
  typeof o === "object" && o !== null && o._tag === "Ref";

/** The dictionary of a dictionary or a stream. */
export const dictOf = (o: PdfObject | undefined): PdfDict | undefined =>
  isDict(o) ? o : isStream(o) ? o.dict : undefined;

/** Decode a string's bytes one byte per character (Latin-1). */
export const bytesToLatin1 = (bytes: Uint8Array): string => {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x2000) {
    s += String.fromCharCode(...bytes.subarray(i, Math.min(i + 0x2000, bytes.length)));
  }
  return s;
};

export const latin1ToBytes = latin1;
