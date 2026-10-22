/**
 * Character encodings: the base encodings of simple fonts (§9.6.5, Annex D),
 * glyph-name-to-Unicode mapping (the Adobe Glyph List and its `uniXXXX`
 * conventions), standard-14 font metrics, and text strings (§7.9.2.2).
 */

import { ENCODING_NAMES, GLYPH_LIST, STANDARD_WIDTHS } from "./data.ts";

/** A base encoding's name. */
export type BaseEncodingName = keyof typeof ENCODING_NAMES;

const encodings = new Map<string, ReadonlyArray<string | undefined>>();

/** A base encoding: the glyph name for each code 0-255. */
export const baseEncoding = (name: BaseEncodingName): ReadonlyArray<string | undefined> => {
  let enc = encodings.get(name);
  if (enc === undefined) {
    enc = ENCODING_NAMES[name].split(" ").map((n) => (n === "." ? undefined : n));
    encodings.set(name, enc);
  }
  return enc;
};

export const isBaseEncodingName = (name: string): name is BaseEncodingName => name in ENCODING_NAMES;

let glyphs: Map<string, number> | undefined;

const glyphTable = (): Map<string, number> => {
  if (glyphs === undefined) {
    glyphs = new Map();
    const parts = GLYPH_LIST.split(" ");
    for (let i = 0; i + 1 < parts.length; i += 2) glyphs.set(parts[i]!, Number.parseInt(parts[i + 1]!, 16));
  }
  return glyphs;
};

const isHex = (s: string): boolean => /^[0-9A-Fa-f]+$/.test(s);

/**
 * The Unicode text for a glyph name: the Adobe Glyph List, then `uniXXXX`
 * (possibly several code units), `uXXXX`-`uXXXXXX`, ligatures written with `_`,
 * and variant suffixes after `.` (`a.sc`).
 */
export const glyphToUnicode = (name: string): string | undefined => {
  const known = glyphTable().get(name);
  if (known !== undefined) return String.fromCodePoint(known);
  const dot = name.indexOf(".");
  if (dot > 0) return glyphToUnicode(name.slice(0, dot));
  if (name.includes("_")) {
    const parts = name.split("_").map(glyphToUnicode);
    return parts.every((p) => p !== undefined) ? parts.join("") : undefined;
  }
  if (name.startsWith("uni") && name.length >= 7 && (name.length - 3) % 4 === 0 && isHex(name.slice(3))) {
    let out = "";
    for (let i = 3; i < name.length; i += 4) out += String.fromCharCode(Number.parseInt(name.slice(i, i + 4), 16));
    return out;
  }
  if (name.startsWith("u") && name.length >= 5 && name.length <= 7 && isHex(name.slice(1))) {
    const cp = Number.parseInt(name.slice(1), 16);
    return cp <= 0x10ffff ? String.fromCodePoint(cp) : undefined;
  }
  return undefined;
};

// ============================================================================
// Text strings
// ============================================================================

let pdfDoc: ReadonlyArray<string> | undefined;

const utf16 = (bytes: Uint8Array, littleEndian: boolean): string => {
  let s = "";
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    s += String.fromCharCode(littleEndian ? bytes[i]! | (bytes[i + 1]! << 8) : (bytes[i]! << 8) | bytes[i + 1]!);
  }
  return s;
};

/** Decode a text string: UTF-16BE or UTF-8 with a byte order mark, else PDFDocEncoding. */
export const decodeTextString = (bytes: Uint8Array): string => {
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return utf16(bytes.subarray(2), false);
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return utf16(bytes.subarray(2), true);
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return new TextDecoder().decode(bytes.subarray(3));
  pdfDoc ??= baseEncoding("PDFDocEncoding").map((n, code) =>
    n === undefined ? (code < 0x20 ? String.fromCharCode(code) : "") : (glyphToUnicode(n) ?? "")
  );
  let out = "";
  for (const b of bytes) out += pdfDoc[b] ?? "";
  return out;
};

// ============================================================================
// WinAnsiEncoding (for writing)
// ============================================================================

let winAnsi: Map<number, number> | undefined;

/** The WinAnsiEncoding code for a character, if it has one. */
export const winAnsiCode = (ch: string): number | undefined => {
  if (winAnsi === undefined) {
    winAnsi = new Map();
    baseEncoding("WinAnsiEncoding").forEach((name, code) => {
      if (name === undefined || code < 0x20) return;
      const u = glyphToUnicode(name);
      if (u !== undefined && !winAnsi!.has(u.codePointAt(0)!)) winAnsi!.set(u.codePointAt(0)!, code);
    });
    winAnsi.set(0xa0, 0xa0); // no-break space
    winAnsi.set(0xad, 0xad); // soft hyphen
  }
  return winAnsi.get(ch.codePointAt(0)!);
};

// ============================================================================
// Standard 14 fonts
// ============================================================================

/** The standard 14 fonts' names. */
export const STANDARD_FONTS = [
  "Helvetica", "Helvetica-Bold", "Helvetica-Oblique", "Helvetica-BoldOblique",
  "Times-Roman", "Times-Bold", "Times-Italic", "Times-BoldItalic",
  "Courier", "Courier-Bold", "Courier-Oblique", "Courier-BoldOblique",
  "Symbol", "ZapfDingbats",
] as const;
export type StandardFont = (typeof STANDARD_FONTS)[number];

/** Common aliases of the standard fonts (as found in real files). */
const ALIASES: Record<string, StandardFont> = {
  Arial: "Helvetica", "Arial,Bold": "Helvetica-Bold", "Arial,Italic": "Helvetica-Oblique",
  "Arial,BoldItalic": "Helvetica-BoldOblique", ArialMT: "Helvetica", "Arial-BoldMT": "Helvetica-Bold",
  "Arial-ItalicMT": "Helvetica-Oblique", "Arial-BoldItalicMT": "Helvetica-BoldOblique",
  TimesNewRoman: "Times-Roman", "TimesNewRoman,Bold": "Times-Bold", "TimesNewRoman,Italic": "Times-Italic",
  "TimesNewRoman,BoldItalic": "Times-BoldItalic", TimesNewRomanPSMT: "Times-Roman",
  "TimesNewRomanPS-BoldMT": "Times-Bold", "TimesNewRomanPS-ItalicMT": "Times-Italic",
  "TimesNewRomanPS-BoldItalicMT": "Times-BoldItalic", CourierNew: "Courier", CourierNewPSMT: "Courier",
  "CourierNew,Bold": "Courier-Bold", "CourierNewPS-BoldMT": "Courier-Bold",
};

/** The standard font a base font name refers to (after stripping a subset tag), if any. */
export const standardFont = (baseFont: string): StandardFont | undefined => {
  const name = baseFont.replace(/^[A-Z]{6}\+/, "");
  if ((STANDARD_FONTS as ReadonlyArray<string>).includes(name)) return name as StandardFont;
  return ALIASES[name];
};

const widthTables = new Map<string, Map<string, number>>();

/** A standard font's glyph widths (1/1000 em) by glyph name. */
export const standardWidths = (font: StandardFont): (glyph: string) => number | undefined => {
  if (font.startsWith("Courier")) return () => 600;
  const key = font.replace("Oblique", "").replace(/-$/, "") as keyof typeof STANDARD_WIDTHS;
  let table = widthTables.get(key);
  if (table === undefined) {
    table = new Map();
    const parts = STANDARD_WIDTHS[key].split(" ");
    for (let i = 0; i + 1 < parts.length; i += 2) table.set(parts[i]!, Number(parts[i + 1]));
    widthTables.set(key, table);
  }
  const t = table;
  return (glyph) => t.get(glyph);
};
