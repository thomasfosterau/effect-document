/**
 * The XLSX Reader: .xlsx bytes -> a multi-worksheet document in the Spreadsheet
 * profile.
 *
 * Unzips the OOXML package with fflate, resolves the workbook and worksheet
 * parts through their relationship files, parses the SpreadsheetML, and builds
 * a dense, typed cell grid per sheet.
 *
 * The grid is sized by the cells that hold a value; empty `<row>`s and
 * style-only `<c>`s do not extend it, and `<dimension>` is honoured only as a
 * hint. A sheet whose extent would exceed `maxCells` fails with a ParseError
 * rather than allocating the grid.
 */

import { Effect, Layer } from "effect";
import { strFromU8, unzipSync } from "fflate";
import {
  cell, type Content, contentToBytes, type Doc, document, type FeaturesOf, makeReaderTag,
  ParseError, type Reader, type SheetCell, SheetRow, trustAs, Worksheet,
} from "@thomasfosterau/effect-document";
import { Spreadsheet } from "@thomasfosterau/effect-document/profiles";
import { parseA1, parseA1Range } from "./a1.js";
import { collectText, spreadsheetMlToCell } from "./cellTypes.js";
import { findChild, findChildren, getAttr, parseXml, type XmlElement } from "./xml.js";

export type SpreadsheetFeature = FeaturesOf<typeof Spreadsheet>;

const REL_OFFICE_DOCUMENT_SUFFIX = "/officeDocument";
const REL_WORKSHEET_SUFFIX = "/worksheet";
const REL_SHARED_STRINGS_SUFFIX = "/sharedStrings";

export interface XlsxReaderOptions {
  /**
   * The most cells (rows × columns) a single worksheet's dense grid may hold.
   * A sheet whose populated extent is larger fails the read with a ParseError
   * instead of exhausting memory. Defaults to {@link DEFAULT_MAX_CELLS}.
   */
  readonly maxCells?: number;
}

/** The default {@link XlsxReaderOptions.maxCells}: five million cells. */
export const DEFAULT_MAX_CELLS = 5_000_000;

// ============================================================================
// OOXML package navigation
// ============================================================================

interface XlsxArchive {
  readonly files: Record<string, Uint8Array>;
}

const readEntry = (archive: XlsxArchive, path: string): string | null => {
  const normalized = path.startsWith("/") ? path.substring(1) : path;
  const entry = archive.files[normalized];
  return entry === undefined ? null : strFromU8(entry);
};

const parseEntry = (
  archive: XlsxArchive,
  path: string,
  format: string
): Effect.Effect<XmlElement, ParseError> =>
  Effect.try({
    try: () => {
      const content = readEntry(archive, path);
      if (content === null) throw new Error(`Missing required package part: ${path}`);
      return parseXml(content);
    },
    catch: (cause) =>
      new ParseError({ format, reason: `Failed to parse "${path}": ${String(cause)}`, cause }),
  });

const resolveTarget = (baseDir: string, target: string): string => {
  if (target.startsWith("/")) return target.substring(1);
  const segments = [...baseDir.split("/").filter((s) => s !== ""), ...target.split("/")];
  const resolved: string[] = [];
  for (const segment of segments) {
    if (segment === "..") resolved.pop();
    else if (segment !== ".") resolved.push(segment);
  }
  return resolved.join("/");
};

const parseRelationships = (
  relsRoot: XmlElement,
  baseDir: string
): ReadonlyArray<{ id: string; type: string; target: string }> =>
  findChildren(relsRoot, "Relationship").map((rel) => ({
    id: getAttr(rel, "Id") ?? "",
    type: getAttr(rel, "Type") ?? "",
    target: resolveTarget(baseDir, getAttr(rel, "Target") ?? ""),
  }));

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
  maxCells: number
): WorksheetGrid => {
  const sheetData = findChild(root, "sheetData");
  if (sheetData === undefined) return { _tag: "Grid", rows: [] };

  // Only cells holding a value are kept, so this map is bounded by the input.
  const cellMap = new Map<number, Map<number, SheetCell>>();
  let maxRow = -1;
  let maxCol = -1;

  for (const [rowOrdinal, rowEl] of findChildren(sheetData, "row").entries()) {
    const rAttr = rowEl.attrs["r"];
    const rowIndex = rAttr !== undefined ? Number.parseInt(rAttr, 10) - 1 : rowOrdinal;

    for (const [colOrdinal, cellEl] of findChildren(rowEl, "c").entries()) {
      const ref = cellEl.attrs["r"];
      const parsed = ref === undefined ? null : parseA1(ref);
      const colIndex = parsed === null ? colOrdinal : parsed.col;
      const effectiveRow = parsed === null ? rowIndex : parsed.row;
      if (!Number.isSafeInteger(effectiveRow) || effectiveRow < 0) continue;

      const value = spreadsheetMlToCell(cellEl, sharedStrings);
      if (value._tag === "CellBlank") continue;

      let rowCells = cellMap.get(effectiveRow);
      if (rowCells === undefined) {
        rowCells = new Map<number, SheetCell>();
        cellMap.set(effectiveRow, rowCells);
      }
      rowCells.set(colIndex, value);

      maxRow = Math.max(maxRow, effectiveRow);
      maxCol = Math.max(maxCol, colIndex);
    }
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
export const makeXlsxReader = (options?: XlsxReaderOptions): Reader<SpreadsheetFeature> => {
  const maxCells = options?.maxCells ?? DEFAULT_MAX_CELLS;

  const read = (input: Content): Effect.Effect<Doc<SpreadsheetFeature>, ParseError> =>
    Effect.gen(function* () {
      const archive: XlsxArchive = yield* Effect.try({
        try: () => ({ files: unzipSync(contentToBytes(input)) }),
        catch: (cause) =>
          new ParseError({
            format: "xlsx",
            reason: `Failed to unzip xlsx package: ${String(cause)}`,
            cause,
          }),
      });

      const rootRels = yield* parseEntry(archive, "_rels/.rels", "xlsx");
      const workbookPath =
        parseRelationships(rootRels, "").find((rel) =>
          rel.type.endsWith(REL_OFFICE_DOCUMENT_SUFFIX)
        )?.target ?? "xl/workbook.xml";
      const workbookDir = workbookPath.substring(0, workbookPath.lastIndexOf("/"));

      const workbookRelsPath = `${workbookDir}/_rels/${workbookPath.substring(workbookPath.lastIndexOf("/") + 1)}.rels`;
      const workbookRels = yield* parseEntry(archive, workbookRelsPath, "xlsx");
      const relationships = parseRelationships(workbookRels, workbookDir);

      const sharedStringsRel = relationships.find((rel) =>
        rel.type.endsWith(REL_SHARED_STRINGS_SUFFIX)
      );
      const sharedStrings: ReadonlyArray<string> =
        sharedStringsRel === undefined
          ? []
          : parseSharedStrings(yield* parseEntry(archive, sharedStringsRel.target, "xlsx"));

      const workbookRoot = yield* parseEntry(archive, workbookPath, "xlsx");
      const sheetsEl = findChild(workbookRoot, "sheets");
      const sheetEntries = sheetsEl === undefined ? [] : findChildren(sheetsEl, "sheet");

      if (sheetEntries.length === 0) {
        return yield* new ParseError({ format: "xlsx", reason: "Workbook contains no sheets" });
      }

      const worksheets: Worksheet[] = [];
      for (const sheetEl of sheetEntries) {
        const name = getAttr(sheetEl, "name") ?? `Sheet${worksheets.length + 1}`;
        const relId = getAttr(sheetEl, "id");
        const target = relationships.find(
          (rel) => rel.id === relId && rel.type.endsWith(REL_WORKSHEET_SUFFIX)
        )?.target;

        if (target === undefined) {
          return yield* new ParseError({
            format: "xlsx",
            reason: `Cannot resolve worksheet part for sheet "${name}" (relationship "${relId}")`,
          });
        }

        const worksheetRoot = yield* parseEntry(archive, target, "xlsx");
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
          })
        );
      }

      return trustAs<SpreadsheetFeature>(document(worksheets));
    });

  return { format: "xlsx", profile: Spreadsheet, read };
};

/** Context tag for dependency-injection style usage. */
export const XlsxReaderTag = makeReaderTag<SpreadsheetFeature>("xlsx");

/** Layer providing an XLSX Reader with default options. */
export const XlsxReaderLive = Layer.succeed(XlsxReaderTag, makeXlsxReader());

/** Layer providing an XLSX Reader with custom options. */
export const makeXlsxReaderLayer = (options?: XlsxReaderOptions) =>
  Layer.succeed(XlsxReaderTag, makeXlsxReader(options));
