/**
 * The XLSX Reader: .xlsx bytes -> a multi-worksheet document in the XLSX read
 * profile.
 *
 * Opens the OOXML package with the shared `OpcReader` (lazy, size-limited
 * inflation), resolves the workbook and worksheet parts through their
 * relationship files, parses the SpreadsheetML, and builds
 * a sparse, typed worksheet per sheet.
 *
 * A worksheet holds only the rows that hold a value: empty `<row>`s and
 * style-only `<c>`s are not kept, and `<dimension>` is not read (it is only a
 * hint). A row's cells are positional, so it costs its width: one past its
 * last valued cell (a sheet with one value at A1 and one at XFD1048576 holds
 * two rows, the second 16,384 positions wide). `maxCells` is one budget of
 * those positions for the whole workbook: a sheet needing more than the
 * sheets before it left fails with a ParseError, so many sheets (or one sheet
 * referenced many times) cannot add up to an unbounded allocation.
 */

import * as Predicate from "effect/Predicate";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Order from "effect/Order";
import {
  type PlainCell,
  type Content,
  contentToBytes,
  type Doc,
  document,
  makeReaderTag,
  ParseError,
  type Reader,
  type SheetCell,
  type SheetRow,
  sparseRow,
  trustAs,
  Worksheet,
} from "@thomasfosterau/effect-document";
import { parseA1 } from "./a1.ts";
import { collectText, spreadsheetMlToCell } from "./cellTypes.ts";
import { translateFormula } from "./formula.ts";
import { OpcError, type OpcLimits, OpcReader, ooxmlParseError } from "../shared/index.ts";
import { findChild, findChildren, getAttr, type XmlElement } from "./xml.ts";

import { XlsxRead, type XlsxReadFeature } from "./profile.ts";

/**
 * The XLSX reader's features under their old name.
 *
 * @deprecated The reader's features are now {@link XlsxReadFeature}.
 */
export type SpreadsheetFeature = XlsxReadFeature;

const REL_OFFICE_DOCUMENT_SUFFIX = "/officeDocument";
const REL_WORKSHEET_SUFFIX = "/worksheet";
/** Sheet kinds without a cell grid, by relationship-type suffix. */
const NON_GRID_SHEET_KINDS: ReadonlyArray<readonly [suffix: string, kind: string]> = [
  ["/chartsheet", "chartsheet"],
  ["/dialogsheet", "dialogsheet"],
  ["/xlMacrosheet", "macrosheet"],
  ["/xlIntlMacrosheet", "macrosheet"],
];
const REL_SHARED_STRINGS_SUFFIX = "/sharedStrings";

/** Options for the XLSX reader: the cell-count limit and the zip resource limits. */
export interface XlsxReaderOptions {
  /**
   * The most cell positions (summed over every worksheet) the workbook may
   * hold: each row held costs its width, one past its last valued cell, as
   * its cells are positional. A sheet needing more than what the sheets
   * before it left fails the read with a ParseError instead of exhausting
   * memory. Rows without a valued cell are not kept, so they cost nothing.
   * Defaults to {@link DEFAULT_MAX_CELLS}.
   */
  readonly maxCells?: number | undefined;
  /** Zip-bomb limits (entry count, entry size, total size); see `OpcLimits`. */
  readonly limits?: OpcLimits | undefined;
}

/** Main-part content types of spreadsheet packages (workbook, macro-enabled, template). */
const WORKBOOK_CONTENT_TYPES = [
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml",
  "application/vnd.ms-excel.sheet.macroEnabled.main+xml",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.template.main+xml",
  "application/vnd.ms-excel.template.macroEnabled.main+xml",
];

/** The default {@link XlsxReaderOptions.maxCells}: five million cell positions. */
export const DEFAULT_MAX_CELLS = 5_000_000;

// ============================================================================
// OOXML package navigation
// ============================================================================

/** A required part, parsed; failures keep the part name and XML position. */
const parsePart = (pkg: OpcReader, path: string): Effect.Effect<XmlElement, ParseError> =>
  Effect.try({
    try: () => {
      const root = pkg.xml(path);
      if (root === null)
        throw new OpcError("MissingPart", `Missing required package part: ${path}`);
      return root;
    },
    catch: (cause) => ooxmlParseError("xlsx", cause),
  });

// ============================================================================
// Sheet parsing
// ============================================================================

const parseSharedStrings = (root: XmlElement): ReadonlyArray<string> =>
  findChildren(root, "si").map(collectText);

type WorksheetRows =
  | { readonly _tag: "Rows"; readonly rows: ReadonlyArray<SheetRow>; readonly cells: number }
  | { readonly _tag: "TooLarge"; readonly cells: number };

/**
 * The plain cell an unstyled text, number or boolean cell is written as (a
 * row holds the bare value, one object fewer a cell); any other cell as it is.
 */
const plainOrCell = (c: SheetCell): SheetCell | PlainCell =>
  c.style !== undefined
    ? c
    : Predicate.isTagged(c, "CellText") || Predicate.isTagged(c, "CellBoolean")
      ? c.value
      : Predicate.isTagged(c, "CellNumber") && Number.isFinite(c.value)
        ? c.value
        : c;

/** A row's valued cells by column as they are read, and its width so far. */
interface RowCellsSoFar {
  readonly cells: Map<number, SheetCell | PlainCell>;
  width: number;
}

/**
 * Widen a row's width to take a cell at `col`: the positions that adds (0
 * when the row is already wider).
 */
const widen = (row: RowCellsSoFar, col: number): number => {
  if (col < row.width) return 0;
  const added = col + 1 - row.width;
  row.width = col + 1;
  return added;
};

/**
 * A worksheet's rows of valued cells, at most `maxCells` (the budget the
 * workbook has left) cell positions: each row costs its width.
 */
const parseWorksheetRows = (
  root: XmlElement,
  sharedStrings: ReadonlyArray<string>,
  maxCells: number,
): WorksheetRows => {
  const sheetData = findChild(root, "sheetData");
  if (sheetData === undefined) return { _tag: "Rows", rows: [], cells: 0 };

  // Rows and cells without an `r` attribute follow the previous one.
  const positioned: Array<{ readonly el: XmlElement; readonly row: number; readonly col: number }> =
    [];
  let rowIndex = -1;
  for (const rowEl of findChildren(sheetData, "row")) {
    const rAttr = rowEl.attrs["r"];
    rowIndex = rAttr !== undefined ? Number.parseInt(rAttr, 10) - 1 : rowIndex + 1;
    let colIndex = -1;
    for (const cellEl of findChildren(rowEl, "c")) {
      const ref = cellEl.attrs["r"];
      const parsed = ref === undefined ? null : parseA1(ref);
      colIndex = parsed === null ? colIndex + 1 : parsed.col;
      const row = parsed === null ? rowIndex : parsed.row;
      if (Number.isSafeInteger(row) && row >= 0 && Number.isSafeInteger(colIndex))
        positioned.push({ el: cellEl, row, col: colIndex });
    }
  }

  // Shared formulas keep their text on the master cell only.
  const sharedMasters = new Map<string, { formula: string; row: number; col: number }>();
  for (const { el, row, col } of positioned) {
    const f = findChild(el, "f");
    const si = f?.attrs["si"];
    if (f !== undefined && f.attrs["t"] === "shared" && si !== undefined && f.text !== "") {
      if (!sharedMasters.has(si)) sharedMasters.set(si, { formula: f.text, row, col });
    }
  }

  // Only cells holding a value are kept, so this map is bounded by the input.
  // A later cell at the same position replaces an earlier one.
  // Each row's width is kept beside its cells: the positions the row will
  // hold, grown as its cells arrive, which is what `maxCells` counts.
  const cellMap = new Map<number, RowCellsSoFar>();
  let count = 0;

  for (const { el, row, col } of positioned) {
    const f = findChild(el, "f");
    const master =
      f !== undefined && f.attrs["t"] === "shared" && f.text === ""
        ? sharedMasters.get(f.attrs["si"] ?? "")
        : undefined;
    const formula =
      master === undefined
        ? undefined
        : translateFormula(master.formula, row - master.row, col - master.col);

    const value = spreadsheetMlToCell(el, sharedStrings, formula);
    if (Predicate.isTagged(value, "CellBlank")) continue;

    let rowCells = cellMap.get(row);
    if (rowCells === undefined) {
      rowCells = { cells: new Map<number, SheetCell | PlainCell>(), width: 0 };
      cellMap.set(row, rowCells);
    }
    count += widen(rowCells, col);
    if (count > maxCells) return { _tag: "TooLarge", cells: count };
    rowCells.cells.set(col, plainOrCell(value));
  }

  // Rows and cells may arrive in any order; the worksheet holds them ascending.
  const byPosition = Order.mapInput(
    Order.Number,
    ([position]: readonly [number, unknown]) => position,
  );
  // Writers emit rows and cells in order, so the sort is skipped when it
  // would change nothing (it runs once per row, and its comparator per cell).
  const ascending = <A>(entries: Iterable<readonly [number, A]>) => {
    const all = Array.from(entries);
    const sorted = all.every((entry, i) => i === 0 || entry[0] > (all[i - 1]?.[0] ?? -1));
    return sorted ? all : Arr.sort(all, byPosition);
  };
  const rows = ascending(cellMap).map(([index, { cells }]) => sparseRow(index, ascending(cells)));
  return { _tag: "Rows", rows, cells: count };
};

// ============================================================================
// Reader
// ============================================================================

/** Create an XLSX Reader with the given options baked in. */
export const makeXlsxReader = (options?: XlsxReaderOptions): Reader<XlsxReadFeature> => {
  const maxCells = options?.maxCells ?? DEFAULT_MAX_CELLS;

  const read = (input: Content): Effect.Effect<Doc<XlsxReadFeature>, ParseError> =>
    Effect.gen(function* () {
      const { pkg, workbookPath, relationships } = yield* Effect.try({
        try: () => {
          const opened = new OpcReader(contentToBytes(input), options?.limits);
          if (opened.text("_rels/.rels") === null)
            throw new OpcError("MissingPart", "Missing required package part: _rels/.rels");
          const mainPath = opened.rootTarget(REL_OFFICE_DOCUMENT_SUFFIX, "xl/workbook.xml");
          opened.expectMainPart(mainPath, "xlsx", WORKBOOK_CONTENT_TYPES);
          return {
            pkg: opened,
            workbookPath: mainPath,
            relationships: opened.rels(mainPath).filter((r) => !r.external),
          };
        },
        catch: (cause) => ooxmlParseError("xlsx", cause),
      });

      const sharedStringsRel = relationships.find((rel) =>
        rel.type.endsWith(REL_SHARED_STRINGS_SUFFIX),
      );
      const sharedStrings: ReadonlyArray<string> =
        sharedStringsRel === undefined
          ? []
          : parseSharedStrings(yield* parsePart(pkg, sharedStringsRel.target));

      const workbookRoot = yield* parsePart(pkg, workbookPath);
      const sheetsEl = findChild(workbookRoot, "sheets");
      const sheetEntries = sheetsEl === undefined ? [] : findChildren(sheetsEl, "sheet");

      if (Arr.isReadonlyArrayEmpty(sheetEntries)) {
        return yield* new ParseError({ format: "xlsx", reason: "Workbook contains no sheets" });
      }

      // The cells every sheet read so far has allocated (sheets are read in
      // order, one at a time), so maxCells bounds the workbook as a whole.
      let allocated = 0;

      const worksheets = yield* Effect.forEach(
        sheetEntries,
        (sheetEl, index) =>
          Effect.gen(function* () {
            const name = getAttr(sheetEl, "name") ?? `Sheet${index + 1}`;
            const relId = getAttr(sheetEl, "id");
            const rel = relationships.find((r) => r.id === relId);

            if (rel !== undefined && !rel.type.endsWith(REL_WORKSHEET_SUFFIX)) {
              // Chartsheets, dialogsheets and macrosheets have no cell grid: keep
              // their place and name as an empty sheet tagged with its kind.
              const kind = NON_GRID_SHEET_KINDS.find(([suffix]) => rel.type.endsWith(suffix))?.[1];
              if (kind !== undefined)
                return new Worksheet({
                  attr: { data: { kind } },
                  name,
                  columns: [],
                  rows: [],
                  merges: [],
                });
            }

            const target =
              rel !== undefined && rel.type.endsWith(REL_WORKSHEET_SUFFIX) ? rel.target : undefined;
            if (target === undefined) {
              return yield* new ParseError({
                format: "xlsx",
                reason: `Cannot resolve worksheet part for sheet "${name}" (relationship "${relId}")`,
              });
            }

            const worksheetRoot = yield* parsePart(pkg, target);
            const remaining = maxCells - allocated;
            const parsed = parseWorksheetRows(worksheetRoot, sharedStrings, remaining);
            if (Predicate.isTagged(parsed, "TooLarge")) {
              return yield* new ParseError({
                format: "xlsx",
                reason:
                  `Worksheet "${name}" holds more than the ${remaining} cells left of the ` +
                  `workbook's ${maxCells}-cell limit (maxCells)`,
              });
            }
            allocated += parsed.cells;
            return new Worksheet({ name, columns: [], rows: parsed.rows, merges: [] });
          }),
        { concurrency: 1 },
      );

      return trustAs<XlsxReadFeature>(document(worksheets));
    });

  return { format: "xlsx", profile: XlsxRead, read };
};

/** Context tag for dependency-injection style usage. */
export const XlsxReaderTag = makeReaderTag<XlsxReadFeature>("xlsx");

/** Layer providing an XLSX Reader with default options. */
export const XlsxReaderLive = Layer.succeed(XlsxReaderTag, makeXlsxReader());

/** Layer providing an XLSX Reader with custom options. */
export const makeXlsxReaderLayer = (options?: XlsxReaderOptions) =>
  Layer.succeed(XlsxReaderTag, makeXlsxReader(options));
