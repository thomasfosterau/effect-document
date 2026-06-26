/**
 * Mapping between effect-document core Cells and SpreadsheetML cell
 * representations.
 *
 * Milestone-1 simplifications (documented):
 * - All numeric cells are read as CellNumber (date detection requires
 *   styles/numFmt parsing, which is out of scope)
 * - CellDate is written as an ISO-8601 shared string, so dates round-trip
 *   as strings rather than Excel serial dates
 */

import { cell, cellToString, type Cell } from "../core/index.js";
import { findChild, type XmlElement } from "./xml.js";

// ============================================================================
// Writing: Cell -> SpreadsheetML <c> fragment
// ============================================================================

/**
 * Accumulates the shared strings table while rendering cells.
 * Returns existing indices for repeated strings.
 */
export class SharedStrings {
  private readonly indices = new Map<string, number>();
  private readonly entries: string[] = [];

  intern(value: string): number {
    const existing = this.indices.get(value);
    if (existing !== undefined) {
      return existing;
    }
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
 * Render a cell as a SpreadsheetML <c> element body, or null if the cell is
 * empty (empty cells are omitted from the output entirely).
 *
 * Returns the type attribute (or null for the default numeric type) and the
 * inner XML of the <c> element.
 */
export const cellToSpreadsheetMl = (
  c: Cell,
  sharedStrings: SharedStrings
): { readonly type: string | null; readonly inner: string } | null => {
  switch (c._tag) {
    case "CellNull":
      return null;
    case "CellNumber":
      return { type: null, inner: `<v>${String(c.value)}</v>` };
    case "CellBoolean":
      return { type: "b", inner: `<v>${c.value ? "1" : "0"}</v>` };
    case "CellString":
    case "CellDate": {
      const index = sharedStrings.intern(cellToString(c));
      return { type: "s", inner: `<v>${index}</v>` };
    }
  }
};

// ============================================================================
// Reading: SpreadsheetML <c> element -> Cell
// ============================================================================

/** Concatenate all <t> descendants of an element (handles rich-text runs) */
export const collectText = (element: XmlElement): string => {
  let result = "";
  const visit = (el: XmlElement): void => {
    if (el.name === "t") {
      result += el.text;
      return;
    }
    for (const child of el.children) {
      visit(child);
    }
  };
  visit(element);
  return result;
};

/**
 * Convert a parsed SpreadsheetML <c> element into a typed Cell.
 */
export const spreadsheetMlToCell = (
  c: XmlElement,
  sharedStrings: ReadonlyArray<string>
): Cell => {
  const type = c.attrs["t"] ?? "n";
  const v = findChild(c, "v");

  switch (type) {
    case "s": {
      // Shared string reference
      if (v === undefined) {
        return cell.empty();
      }
      const index = Number.parseInt(v.text, 10);
      const value = sharedStrings[index];
      return value === undefined ? cell.empty() : cell.str(value);
    }
    case "inlineStr": {
      const is = findChild(c, "is");
      return is === undefined ? cell.empty() : cell.str(collectText(is));
    }
    case "str":
      // Formula result string
      return v === undefined ? cell.empty() : cell.str(v.text);
    case "b":
      return v === undefined ? cell.empty() : cell.bool(v.text.trim() === "1");
    case "e":
      // Error cells surface as their error code text (#DIV/0!, #N/A, ...)
      return v === undefined ? cell.empty() : cell.str(v.text);
    default: {
      // "n" or unspecified: numeric
      if (v === undefined || v.text.trim() === "") {
        return cell.empty();
      }
      const num = Number(v.text);
      return Number.isFinite(num) ? cell.num(num) : cell.str(v.text);
    }
  }
};
