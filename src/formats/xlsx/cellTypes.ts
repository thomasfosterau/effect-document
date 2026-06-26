/**
 * Mapping between schema spreadsheet cells and SpreadsheetML cell representations.
 *
 * Current simplifications (documented):
 * - Numeric cells are read as CellNumber; date detection (which needs style /
 *   numFmt parsing) is out of scope, so `CellDate` is *written* as an ISO-8601
 *   shared string and round-trips as text.
 * - Rich-text cells are written as their flattened text.
 */

import {
  type SheetCell, cell, cellToText, inlinesToText,
} from "../../schema/index.js";
import { escapeXml, findChild, type XmlElement } from "./xml.js";

// ============================================================================
// Writing: SheetCell -> SpreadsheetML <c> fragment
// ============================================================================

/** Accumulates the shared strings table while rendering cells. */
export class SharedStrings {
  private readonly indices = new Map<string, number>();
  private readonly entries: string[] = [];

  intern(value: string): number {
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
}

/**
 * Render a cell as a SpreadsheetML `<c>` element body, or null for a blank cell
 * (blank cells are omitted entirely). Returns the `t` attribute (or null for the
 * default numeric type) and the inner XML.
 */
export const cellToSpreadsheetMl = (
  c: SheetCell,
  sharedStrings: SharedStrings
): { readonly type: string | null; readonly inner: string } | null => {
  switch (c._tag) {
    case "CellBlank":
      return null;
    case "CellNumber":
      return { type: null, inner: `<v>${String(c.value)}</v>` };
    case "CellBoolean":
      return { type: "b", inner: `<v>${c.value ? "1" : "0"}</v>` };
    case "CellError":
      return { type: "e", inner: `<v>${escapeXml(c.value)}</v>` };
    case "CellFormula":
      return {
        type: "str",
        inner: `<f>${escapeXml(c.formula)}</f><v>${escapeXml(c.result ?? "")}</v>`,
      };
    case "CellText":
      return { type: "s", inner: `<v>${sharedStrings.intern(c.value)}</v>` };
    case "CellDate":
      return { type: "s", inner: `<v>${sharedStrings.intern(c.value.toISOString())}</v>` };
    case "CellRichText":
      return { type: "s", inner: `<v>${sharedStrings.intern(inlinesToText(c.runs))}</v>` };
  }
};

// ============================================================================
// Reading: SpreadsheetML <c> element -> SheetCell
// ============================================================================

/** Concatenate all `<t>` descendants of an element (handles rich-text runs). */
export const collectText = (element: XmlElement): string => {
  let result = "";
  const visit = (el: XmlElement): void => {
    if (el.name === "t") {
      result += el.text;
      return;
    }
    for (const child of el.children) visit(child);
  };
  visit(element);
  return result;
};

/** Convert a parsed SpreadsheetML `<c>` element into a typed cell. */
export const spreadsheetMlToCell = (
  c: XmlElement,
  sharedStrings: ReadonlyArray<string>
): SheetCell => {
  const type = c.attrs["t"] ?? "n";
  const v = findChild(c, "v");

  // A formula cell carries an <f> element; round-trip it as a CellFormula
  // (with its cached <v> result) rather than flattening to the result text.
  const f = findChild(c, "f");
  if (f !== undefined) {
    return cell.formula(f.text, v === undefined ? undefined : v.text);
  }

  switch (type) {
    case "s": {
      if (v === undefined) return cell.blank();
      const index = Number.parseInt(v.text, 10);
      const value = sharedStrings[index];
      return value === undefined ? cell.blank() : cell.text(value);
    }
    case "inlineStr": {
      const is = findChild(c, "is");
      return is === undefined ? cell.blank() : cell.text(collectText(is));
    }
    case "str":
      return v === undefined ? cell.blank() : cell.text(v.text);
    case "b":
      return v === undefined ? cell.blank() : cell.boolean(v.text.trim() === "1");
    case "e":
      return v === undefined ? cell.blank() : cell.error(v.text);
    default: {
      if (v === undefined || v.text.trim() === "") return cell.blank();
      const num = Number(v.text);
      return Number.isFinite(num) ? cell.number(num) : cell.text(v.text);
    }
  }
};
