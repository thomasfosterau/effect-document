/**
 * Fonts, for text extraction (ISO 32000-2 §9.5-9.10): how a shown string's
 * bytes split into character codes, what Unicode text each code stands for,
 * and how far each glyph advances.
 *
 * Unicode comes from the font's `/ToUnicode` CMap when there is one, otherwise
 * (simple fonts) from its encoding - a base encoding plus `/Differences` glyph
 * names - or (Type 0 fonts with a UCS-2/UTF-16 CMap) from the codes
 * themselves. Style hints (bold, italic, monospaced) come from the font name
 * and descriptor.
 */

import type { PdfFile } from "../cos/file.ts";
import { type PdfDict, type PdfObject, isArray, isName, isStream } from "../cos/objects.ts";
import { CMap, parseCMap } from "./cmap.ts";
import {
  type BaseEncodingName, baseEncoding, glyphToUnicode, isBaseEncodingName, standardFont, standardWidths,
} from "./encodings.ts";

/** One decoded character code. */
export interface Glyph {
  readonly code: number;
  /** The Unicode text it stands for (may be empty, or several characters for a ligature). */
  readonly text: string;
  /** Horizontal advance, in text space units per unit font size (glyph width / 1000). */
  readonly width: number;
  /** Whether word spacing (`Tw`) applies: a single-byte code 32. */
  readonly wordSpace: boolean;
}

/** A font, as text extraction needs it. */
export interface PdfFont {
  /** The base font name, without a subset tag. */
  readonly name: string;
  readonly bold: boolean;
  readonly italic: boolean;
  readonly monospace: boolean;
  /** Vertical writing mode. */
  readonly vertical: boolean;
  /** Split a shown string into glyphs. */
  readonly decode: (bytes: Uint8Array) => Glyph[];
}

const FIXED_PITCH = 1;
const SYMBOLIC = 4;
const ITALIC = 64;
const FORCE_BOLD = 1 << 18;

const BOLD_NAME = /bold|black|heavy|semibold|demi|extrabold|ultrabold|,bd/i;
const ITALIC_NAME = /italic|oblique|slanted|,it\b|-it$|-ital/i;
const MONO_NAME = /courier|mono|consol|menlo|inconsolata|lucidaconsole|code/i;

const numbers = (file: PdfFile, o: PdfObject | undefined): number[] => {
  const a = file.resolve(o);
  return isArray(a) ? a.items.map((x) => file.resolve(x)).map((x) => (typeof x === "number" ? x : 0)) : [];
};

/** Style hints from the font name and descriptor. */
const style = (file: PdfFile, name: string, descriptor: PdfDict | undefined) => {
  const flags = file.lookupNumber(descriptor, "Flags") ?? 0;
  const weight = file.lookupNumber(descriptor, "FontWeight") ?? 0;
  const angle = file.lookupNumber(descriptor, "ItalicAngle") ?? 0;
  return {
    bold: BOLD_NAME.test(name) || (flags & FORCE_BOLD) !== 0 || weight >= 600,
    italic: ITALIC_NAME.test(name) || (flags & ITALIC) !== 0 || angle !== 0,
    monospace: MONO_NAME.test(name) || (flags & FIXED_PITCH) !== 0,
  };
};

const loadToUnicode = (file: PdfFile, dict: PdfDict): CMap | undefined => {
  const tu = file.lookup(dict, "ToUnicode");
  if (!isStream(tu)) return undefined;
  try {
    const cmap = parseCMap(file.decode(tu).data, glyphToUnicode);
    return cmap.hasUnicode ? cmap : undefined;
  } catch {
    return undefined;
  }
};

// ============================================================================
// Simple fonts (Type1, TrueType, Type3, MMType1)
// ============================================================================

const loadSimpleFont = (file: PdfFile, dict: PdfDict, subtype: string): PdfFont => {
  const baseFont = (file.lookupName(dict, "BaseFont") ?? "").replace(/^[A-Z]{6}\+/, "");
  const descriptor = file.lookupDict(dict, "FontDescriptor");
  const flags = file.lookupNumber(descriptor, "Flags") ?? 0;
  const standard = standardFont(baseFont);

  // the encoding: a base encoding, then /Differences
  let base: BaseEncodingName =
    standard === "Symbol" ? "SymbolEncoding" : standard === "ZapfDingbats" ? "ZapfDingbatsEncoding"
      : subtype === "TrueType" ? "WinAnsiEncoding" : "StandardEncoding";
  const names: Array<string | undefined> = [];
  const encoding = file.lookup(dict, "Encoding");
  let explicit = false;
  if (isName(encoding) && isBaseEncodingName(encoding.name)) {
    base = encoding.name;
    explicit = true;
  } else if (encoding !== undefined && encoding !== null && typeof encoding === "object" && encoding._tag === "Dict") {
    const b = file.lookupName(encoding, "BaseEncoding");
    if (b !== undefined && isBaseEncodingName(b)) base = b;
    explicit = true;
    let code = 0;
    for (const item of file.lookupArray(encoding, "Differences")?.items ?? []) {
      const x = file.resolve(item);
      if (typeof x === "number") code = x;
      else if (isName(x)) names[code++] = x.name;
    }
  }
  const baseNames = baseEncoding(base);
  const glyphName = (code: number): string | undefined => names[code] ?? baseNames[code];
  // symbolic TrueType fonts without an encoding index their glyphs by code directly
  const symbolicTrueType = subtype === "TrueType" && !explicit && (flags & SYMBOLIC) !== 0;

  const toUnicode = loadToUnicode(file, dict);
  const unicode = (code: number): string => {
    const tu = toUnicode?.toUnicode(code, 1);
    if (tu !== undefined) return tu;
    if (symbolicTrueType) return code >= 0x20 ? String.fromCharCode(code) : "";
    const name = glyphName(code);
    const fromName = name === undefined ? undefined : glyphToUnicode(name);
    if (fromName !== undefined) return fromName;
    // an unknown glyph name (`g12`, `cid42`): fall back to the base encoding
    const baseName = baseNames[code];
    return baseName === undefined ? "" : (glyphToUnicode(baseName) ?? "");
  };

  // widths
  const firstChar = file.lookupNumber(dict, "FirstChar") ?? 0;
  const widths = numbers(file, dict.entries.get("Widths"));
  const missing = file.lookupNumber(descriptor, "MissingWidth");
  const matrix = numbers(file, dict.entries.get("FontMatrix"));
  const scale = subtype === "Type3" && matrix.length >= 1 ? matrix[0]! : 0.001;
  const stdWidth = standard === undefined ? undefined : standardWidths(standard);
  const width = (code: number): number => {
    const w = widths[code - firstChar];
    if (w !== undefined && w > 0) return w * scale;
    const sw = stdWidth?.(glyphName(code) ?? "");
    if (sw !== undefined) return sw * 0.001;
    if (missing !== undefined && missing > 0) return missing * scale;
    return w !== undefined ? 0 : 0.5;
  };

  const cache = new Map<number, Glyph>();
  const glyph = (code: number): Glyph => {
    let g = cache.get(code);
    if (g === undefined) {
      g = { code, text: unicode(code), width: width(code), wordSpace: code === 32 };
      cache.set(code, g);
    }
    return g;
  };
  return {
    name: baseFont,
    ...style(file, baseFont, descriptor),
    vertical: false,
    decode: (bytes) => Array.from(bytes, glyph),
  };
};

// ============================================================================
// Composite fonts (Type0)
// ============================================================================

const identity = (): CMap => {
  const c = new CMap();
  c.addCodespace(Uint8Array.of(0, 0), Uint8Array.of(0xff, 0xff));
  return c;
};

const loadType0Font = (file: PdfFile, dict: PdfDict): PdfFont => {
  const baseFont = (file.lookupName(dict, "BaseFont") ?? "").replace(/^[A-Z]{6}\+/, "");
  const descendants = file.lookupArray(dict, "DescendantFonts");
  const cidFont = descendants === undefined ? undefined : file.resolve(descendants.items[0]);
  const cid = cidFont !== null && typeof cidFont === "object" && cidFont._tag === "Dict" ? cidFont : undefined;
  const descriptor = file.lookupDict(cid, "FontDescriptor");

  // the encoding CMap: codes -> CIDs
  const encoding = file.lookup(dict, "Encoding");
  let cmap: CMap = identity();
  let unicodeCodes = false; // codes are UTF-16 (Uni*-UCS2-*, Uni*-UTF16-*)
  let vertical = false;
  if (isName(encoding)) {
    vertical = encoding.name.endsWith("-V");
    if (/UCS2|UTF16/.test(encoding.name)) unicodeCodes = true;
  } else if (isStream(encoding)) {
    try {
      const parsed = parseCMap(file.decode(encoding).data);
      if (parsed.codespaces.length === 0) {
        for (const space of identity().codespaces) parsed.codespaces.push(space);
      }
      cmap = parsed;
      vertical = parsed.vertical;
    } catch {
      // keep Identity-H
    }
  }
  const toCid = (code: number, len: number): number => cmap.toCid(code, len) ?? code;

  const toUnicode = loadToUnicode(file, dict);
  const unicode = (code: number, len: number): string => {
    const tu = toUnicode?.toUnicode(code, len);
    if (tu !== undefined) return tu;
    if (unicodeCodes) return len === 2 ? String.fromCharCode(code) : String.fromCodePoint(code);
    return "";
  };

  // widths: /DW and /W
  const defaultWidth = (file.lookupNumber(cid, "DW") ?? 1000) * 0.001;
  const widths = new Map<number, number>();
  const w = file.lookupArray(cid, "W")?.items.map((x) => file.resolve(x)) ?? [];
  for (let i = 0; i < w.length;) {
    const first = w[i];
    const next = w[i + 1];
    if (typeof first !== "number") break;
    if (isArray(next)) {
      next.items.forEach((x, j) => {
        const v = file.resolve(x);
        if (typeof v === "number") widths.set(first + j, v * 0.001);
      });
      i += 2;
    } else {
      const last = next;
      const v = w[i + 2];
      if (typeof last !== "number" || typeof v !== "number") break;
      for (let c = first; c <= last && c - first < 65536; c++) widths.set(c, v * 0.001);
      i += 3;
    }
  }

  return {
    name: baseFont,
    ...style(file, baseFont, descriptor),
    vertical,
    decode: (bytes) =>
      cmap.codes(bytes, 2).map(({ code, len }) => ({
        code,
        text: unicode(code, len),
        width: widths.get(toCid(code, len)) ?? defaultWidth,
        wordSpace: len === 1 && code === 32,
      })),
  };
};

// ============================================================================

const FALLBACK_FONT: PdfFont = {
  name: "",
  bold: false,
  italic: false,
  monospace: false,
  vertical: false,
  decode: (bytes) => Array.from(bytes, (code) => ({ code, text: code >= 0x20 ? String.fromCharCode(code) : "", width: 0.5, wordSpace: code === 32 })),
};

/** Load a font dictionary for text extraction. */
export const loadFont = (file: PdfFile, font: PdfObject | undefined): PdfFont => {
  const dict = file.resolve(font);
  if (dict === null || dict === undefined || typeof dict !== "object" || dict._tag !== "Dict") return FALLBACK_FONT;
  try {
    const subtype = file.lookupName(dict, "Subtype") ?? "Type1";
    return subtype === "Type0" ? loadType0Font(file, dict) : loadSimpleFont(file, dict, subtype);
  } catch {
    return FALLBACK_FONT;
  }
};
