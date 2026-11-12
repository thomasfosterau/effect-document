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
import * as Option from "effect/Option";
import { cell, type SheetCell } from "../../index.ts";
import { cellOfText, decodeXstring, type SharedString } from "./cellText.ts";
import { richTextRunsXml } from "./richText.ts";
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
/** A rich entry of the writer's shared-string table: its `<si>` content, ready to write. */
export interface RichEntry {
  readonly runsXml: string;
}

export class SharedStrings {
  private readonly indices = new Map<string, number>();
  private readonly richIndices = new Map<string, number>();
  private readonly entries: Array<string | RichEntry> = [];
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

  /** Intern a rich string by its runs' XML (`<r>`…), shared with any cell whose runs read the same. */
  internRich(runsXml: string): number {
    this.references++;
    const existing = this.richIndices.get(runsXml);
    if (existing !== undefined) return existing;
    const index = this.entries.length;
    this.richIndices.set(runsXml, index);
    this.entries.push({ runsXml });
    return index;
  }

  /** The table's entries in index order: each a plain string, or a rich one's runs. */
  get strings(): ReadonlyArray<string | RichEntry> {
    return this.entries;
  }

  /** The number of cells referring to the table (`sst@count`). */
  get count(): number {
    return this.references;
  }
}

/** A cell as SpreadsheetML: its `t` attribute (`null` for the default, a number) and its inner XML. */
export interface RenderedCell {
  readonly type: string | null;
  readonly inner: string;
}

/**
 * What {@link cellToSpreadsheetMl} renders a `NaN` or `±Infinity` number as:
 * the `#NUM!` error cell, as one shared object so the writer can spot it by
 * identity (and report it, #112) without a per-cell check.
 */
export const NON_FINITE_CELL: RenderedCell = {
  type: "e",
  inner: "<v>#NUM!</v>",
};

/**
 * Render a cell as a SpreadsheetML `<c>` element body, or null for a blank cell
 * (blank cells are omitted entirely). Returns the `t` attribute (or null for the
 * default numeric type) and the inner XML.
 */
export const cellToSpreadsheetMl = (
  c: SheetCell,
  sharedStrings: SharedStrings,
): RenderedCell | null => {
  // a branch per cell type; `Match.valueTags` keeps the mapping exhaustive
  const shared = (text: string) => ({ type: "s", inner: `<v>${sharedStrings.intern(text)}</v>` });
  return Match.valueTags(c, {
    CellBlank: () => null,
    // SpreadsheetML numbers are finite; NaN and ±Infinity become #NUM!.
    CellNumber: (n) =>
      Number.isFinite(n.value)
        ? { type: null, inner: `<v>${String(n.value)}</v>` }
        : NON_FINITE_CELL,
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
    CellRichText: (n) => ({
      type: "s",
      inner: `<v>${sharedStrings.internRich(richTextRunsXml(n.runs, escapeXstring))}</v>`,
    }),
  });
};

// ============================================================================
// Reading: SpreadsheetML <c> element -> SheetCell
// ============================================================================

export { decodeXstring } from "./cellText.ts";

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
  sharedStrings: ReadonlyArray<SharedString>,
  formula?: string,
): SheetCell => {
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

  const is = findChild(c, "is");
  return cellOfText(
    c.attrs["t"] ?? "n",
    Option.fromUndefinedOr(v?.text),
    Option.map(Option.fromUndefinedOr(is), collectText),
    sharedStrings,
  );
};
