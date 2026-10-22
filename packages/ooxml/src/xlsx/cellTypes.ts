/**
 * Mapping between schema spreadsheet cells and SpreadsheetML cell representations.
 *
 * Current simplifications (documented):
 * - Numeric cells are read as CellNumber; date detection (which needs style /
 *   numFmt parsing) is out of scope, so `CellDate` is *written* as an ISO-8601
 *   shared string and round-trips as text. ISO 8601 `t="d"` cells are read as
 *   CellDate.
 * - Rich-text cells are written as their flattened text.
 */

import * as Match from "effect/Match";
import { cell, inlinesToText, type SheetCell } from "@thomasfosterau/effect-document";
import { escapeXml, findChild, type XmlElement } from "./xml.ts";

// ============================================================================
// Writing: SheetCell -> SpreadsheetML <c> fragment
// ============================================================================

/**
 * Encode a string as SpreadsheetML ST_Xstring: characters XML 1.0 can't carry
 * (C0 controls other than tab, LF and CR, lone surrogates, U+FFFE/U+FFFF)
 * become `_xHHHH_`, and the underscore of a literal `_xHHHH_` is escaped as
 * `_x005F_` so it survives decoding. The inverse of {@link decodeXstring}.
 */
export const encodeXstring = (s: string): string =>
  s.replace(
    // oxlint-disable-next-line eslint/no-control-regex -- the C0 controls are among the characters to encode
    /_(?=x[0-9A-Fa-f]{4}_)|[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,
    (ch) => `_x${ch.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0")}_`,
  );

/** Escape and ST_Xstring-encode text for a SpreadsheetML element. */
export const escapeXstring = (s: string): string => escapeXml(encodeXstring(s));

/** Accumulates the shared strings table while rendering cells. */
export class SharedStrings {
  private readonly indices = new Map<string, number>();
  private readonly entries: string[] = [];
  private references = 0;

  intern(value: string): number {
    this.references++;
    const existing = this.indices.get(value);
    if (existing !== undefined) return existing;
    const index = this.entries.length;
    this.indices.set(value, index);
    this.entries.push(value);
    return index;
  }

  get strings(): ReadonlyArray<string> {
    return this.entries;
  }

  /** The number of cells referring to the table (`sst@count`). */
  get count(): number {
    return this.references;
  }
}

/**
 * Render a cell as a SpreadsheetML `<c>` element body, or null for a blank cell
 * (blank cells are omitted entirely). Returns the `t` attribute (or null for the
 * default numeric type) and the inner XML.
 */
export const cellToSpreadsheetMl = (
  c: SheetCell,
  sharedStrings: SharedStrings,
): { readonly type: string | null; readonly inner: string } | null => {
  // a branch per cell type; `Match.valueTags` keeps the mapping exhaustive
  const shared = (text: string) => ({ type: "s", inner: `<v>${sharedStrings.intern(text)}</v>` });
  return Match.valueTags(c, {
    CellBlank: () => null,
    // SpreadsheetML numbers are finite; NaN and ±Infinity become #NUM!.
    CellNumber: (n) =>
      Number.isFinite(n.value)
        ? { type: null, inner: `<v>${String(n.value)}</v>` }
        : { type: "e", inner: "<v>#NUM!</v>" },
    CellBoolean: (n) => ({ type: "b", inner: `<v>${n.value ? "1" : "0"}</v>` }),
    CellError: (n) => ({ type: "e", inner: `<v>${escapeXstring(n.value)}</v>` }),
    // SpreadsheetML stores formulas without the leading "=".
    CellFormula: (n) => ({
      type: "str",
      inner:
        `<f>${escapeXstring(n.formula.replace(/^=/, ""))}</f>` +
        `<v>${escapeXstring(n.result ?? "")}</v>`,
    }),
    CellText: (n) => shared(n.value),
    CellDate: (n) => shared(n.value.toISOString()),
    CellRichText: (n) => shared(inlinesToText(n.runs)),
  });
};

// ============================================================================
// Reading: SpreadsheetML <c> element -> SheetCell
// ============================================================================

/**
 * Decode SpreadsheetML's `_xHHHH_` escapes (ST_Xstring), which carry
 * characters XML 1.0 can't (control characters, lone surrogates). `_x005F_`
 * escapes a literal underscore, so `_x005F_x0041_` decodes to `_x0041_`.
 */
export const decodeXstring = (s: string): string =>
  s.includes("_x")
    ? s.replace(/_x([0-9A-Fa-f]{4})_/g, (_, hex: string) =>
        String.fromCharCode(Number.parseInt(hex, 16)),
      )
    : s;

/**
 * Concatenate all `<t>` descendants of an element (handles rich-text runs),
 * skipping phonetic guides (`<rPh>`), which annotate the base text rather
 * than belong to it.
 */
export const collectText = (element: XmlElement): string => {
  let result = "";
  const visit = (el: XmlElement): void => {
    if (el.name === "t") {
      result += el.text;
      return;
    }
    if (el.name === "rPh") return;
    for (const child of el.children) visit(child);
  };
  visit(element);
  return decodeXstring(result);
};

/**
 * Convert a parsed SpreadsheetML `<c>` element into a typed cell.
 *
 * `formula` overrides the `<f>` text; the reader passes it for the dependent
 * cells of a shared formula, whose `<f>` is empty.
 */
export const spreadsheetMlToCell = (
  c: XmlElement,
  sharedStrings: ReadonlyArray<string>,
  formula?: string,
): SheetCell => {
  const type = c.attrs["t"] ?? "n";
  const v = findChild(c, "v");

  // A formula cell carries an <f> element; round-trip it as a CellFormula
  // (with its cached <v> result) rather than flattening to the result text.
  const f = findChild(c, "f");
  if (f !== undefined) {
    return cell.formula(
      formula ?? decodeXstring(f.text),
      v === undefined ? undefined : decodeXstring(v.text),
    );
  }

  if (type === "s") {
    if (v === undefined) return cell.blank();
    const index = Number.parseInt(v.text, 10);
    const value = sharedStrings[index];
    return value === undefined ? cell.blank() : cell.text(value);
  } else if (type === "inlineStr") {
    const is = findChild(c, "is");
    return is === undefined ? cell.blank() : cell.text(collectText(is));
  } else if (type === "str") {
    return v === undefined ? cell.blank() : cell.text(decodeXstring(v.text));
  } else if (type === "b") {
    return v === undefined ? cell.blank() : cell.boolean(v.text.trim() === "1");
  } else if (type === "e") {
    return v === undefined ? cell.blank() : cell.error(v.text);
  } else if (type === "d") {
    // An ISO 8601 date (Strict files and some producers).
    if (v === undefined || v.text.trim() === "") return cell.blank();
    // oxlint-disable-next-line effect/use-clock-service -- parses the cell's date, never reads the clock
    const date = new Date(v.text.trim());
    return Number.isNaN(date.getTime()) ? cell.text(v.text) : cell.date(date);
  } else {
    if (v === undefined || v.text.trim() === "") return cell.blank();
    const num = Number(v.text);
    return Number.isFinite(num) ? cell.number(num) : cell.text(v.text);
  }
};
