/**
 * The XLSX Reader: .xlsx bytes -> a multi-worksheet document in the XLSX read
 * profile.
 *
 * Opens the OOXML package with the shared `OpcReader` (lazy, size-limited
 * inflation), resolves the workbook and worksheet parts through their
 * relationship files, parses the SpreadsheetML, and builds
 * a dense, typed cell grid per sheet.
 *
 * The grid is sized by the cells that hold a value; empty `<row>`s and
 * style-only `<c>`s do not extend it, and `<dimension>` is honoured only as a
 * hint. A sheet whose extent would exceed `maxCells` fails with a ParseError
 * rather than allocating the grid.
 */

import { Effect, Layer } from "effect";
import {
  cell,
  type Content,
  contentToBytes,
  type Doc,
  document,
  makeReaderTag,
  ParseError,
  type Reader,
  type SheetCell,
  SheetRow,
  trustAs,
  Worksheet,
} from "@thomasfosterau/effect-document";
import { parseA1, parseA1Range } from "./a1.ts";
import { collectText, spreadsheetMlToCell } from "./cellTypes.ts";
import { translateFormula } from "./formula.ts";
import { type OpcLimits, OpcReader, ooxmlParseError } from "../shared/index.ts";
import { findChild, findChildren, getAttr, type XmlElement } from "./xml.ts";

import { XlsxRead, type XlsxReadFeature } from "./profile.ts";

/** @deprecated The reader's features are now {@link XlsxReadFeature}. */
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

export interface XlsxReaderOptions {
  /**
   * The most cells (rows × columns) a single worksheet's dense grid may hold.
   * A sheet whose populated extent is larger fails the read with a ParseError
   * instead of exhausting memory. Defaults to {@link DEFAULT_MAX_CELLS}.
   */
  readonly maxCells?: number | undefined;
  /** Zip resource limits (entry count, inflated bytes); see `OpcLimits`. */
  readonly limits?: Partial<OpcLimits> | undefined;
}

/** Main-part content types of spreadsheet packages (workbook, macro-enabled, template). */
const WORKBOOK_CONTENT_TYPES = [
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml",
  "application/vnd.ms-excel.sheet.macroEnabled.main+xml",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.template.main+xml",
  "application/vnd.ms-excel.template.macroEnabled.main+xml",
];

/** The default {@link XlsxReaderOptions.maxCells}: five million cells. */
export const DEFAULT_MAX_CELLS = 5_000_000;

// ============================================================================
// OOXML package navigation
// ============================================================================

/** A required part, parsed; failures keep the part name and XML position. */
const parsePart = (pkg: OpcReader, path: string): Effect.Effect<XmlElement, ParseError> =>
  Effect.try({
    try: () => {
      const root = pkg.xml(path);
      if (root === null) throw new Error(`Missing required package part: ${path}`);
      return root;
    },
    catch: (cause) => ooxmlParseError("xlsx", cause),
  });

// ============================================================================
// Sheet parsing
// ============================================================================

const parseSharedStrings = (root: XmlElement): ReadonlyArray<string> =>
  findChildren(root, "si").map(collectText);

type WorksheetGrid =
  | { readonly _tag: "Grid"; readonly rows: ReadonlyArray<ReadonlyArray<SheetCell>> }
  | { readonly _tag: "TooLarge"; readonly rows: number; readonly columns: number };

/** The extent declared by `<dimension ref="A1:C3">`, as row and column counts. */
const declaredExtent = (root: XmlElement): { rows: number; columns: number } | null => {
  const ref = findChild(root, "dimension")?.attrs["ref"];
  const range = ref === undefined ? null : parseA1Range(ref);
  if (range === null) return null;
  return {
    rows: Math.max(range.start.row, range.end.row) + 1,
    columns: Math.max(range.start.col, range.end.col) + 1,
  };
};

const parseWorksheetRows = (
  root: XmlElement,
  sharedStrings: ReadonlyArray<string>,
  maxCells: number,
): WorksheetGrid => {
  const sheetData = findChild(root, "sheetData");
  if (sheetData === undefined) return { _tag: "Grid", rows: [] };

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
      if (Number.isSafeInteger(row) && row >= 0)
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
  const cellMap = new Map<number, Map<number, SheetCell>>();
  let maxRow = -1;
  let maxCol = -1;

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
    if (value._tag === "CellBlank") continue;

    let rowCells = cellMap.get(row);
    if (rowCells === undefined) {
      rowCells = new Map<number, SheetCell>();
      cellMap.set(row, rowCells);
    }
    rowCells.set(col, value);

    maxRow = Math.max(maxRow, row);
    maxCol = Math.max(maxCol, col);
  }

  if (maxRow < 0 || maxCol < 0) return { _tag: "Grid", rows: [] };
  if ((maxRow + 1) * (maxCol + 1) > maxCells) {
    return { _tag: "TooLarge", rows: maxRow + 1, columns: maxCol + 1 };
  }

  // <dimension> may widen the grid to keep trailing blank rows/columns (as the
  // writer declares them), but it is only a hint: ignore it when it would
  // exceed the cell limit.
  let rowCount = maxRow + 1;
  let colCount = maxCol + 1;
  const declared = declaredExtent(root);
  if (declared !== null) {
    const rows = Math.max(rowCount, declared.rows);
    const columns = Math.max(colCount, declared.columns);
    if (rows * columns <= maxCells) {
      rowCount = rows;
      colCount = columns;
    }
  }

  const rows: SheetCell[][] = [];
  for (let r = 0; r < rowCount; r++) {
    const rowCells = cellMap.get(r);
    const row: SheetCell[] = [];
    for (let c = 0; c < colCount; c++) row.push(rowCells?.get(c) ?? cell.blank());
    rows.push(row);
  }
  return { _tag: "Grid", rows };
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
          const pkg = new OpcReader(contentToBytes(input), options?.limits);
          if (pkg.text("_rels/.rels") === null)
            throw new Error("Missing required package part: _rels/.rels");
          const workbookPath = pkg.rootTarget(REL_OFFICE_DOCUMENT_SUFFIX, "xl/workbook.xml");
          pkg.expectMainPart(workbookPath, "xlsx", WORKBOOK_CONTENT_TYPES);
          return {
            pkg,
            workbookPath,
            relationships: pkg.rels(workbookPath).filter((r) => !r.external),
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

      if (sheetEntries.length === 0) {
        return yield* new ParseError({ format: "xlsx", reason: "Workbook contains no sheets" });
      }

      const worksheets: Worksheet[] = [];
      for (const sheetEl of sheetEntries) {
        const name = getAttr(sheetEl, "name") ?? `Sheet${worksheets.length + 1}`;
        const relId = getAttr(sheetEl, "id");
        const rel = relationships.find((r) => r.id === relId);

        if (rel !== undefined && !rel.type.endsWith(REL_WORKSHEET_SUFFIX)) {
          // Chartsheets, dialogsheets and macrosheets have no cell grid: keep
          // their place and name as an empty sheet tagged with its kind.
          const kind = NON_GRID_SHEET_KINDS.find(([suffix]) => rel.type.endsWith(suffix))?.[1];
          if (kind !== undefined) {
            worksheets.push(
              new Worksheet({ attr: { data: { kind } }, name, columns: [], rows: [], merges: [] }),
            );
            continue;
          }
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
        const grid = parseWorksheetRows(worksheetRoot, sharedStrings, maxCells);
        if (grid._tag === "TooLarge") {
          return yield* new ParseError({
            format: "xlsx",
            reason:
              `Worksheet "${name}" spans ${grid.rows} rows × ${grid.columns} columns, ` +
              `more than the ${maxCells}-cell limit (maxCells)`,
          });
        }
        worksheets.push(
          new Worksheet({
            name,
            columns: [],
            rows: grid.rows.map((cells) => new SheetRow({ cells })),
            merges: [],
          }),
        );
      }

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
