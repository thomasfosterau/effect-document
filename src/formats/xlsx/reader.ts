/**
 * The XLSX Reader: .xlsx bytes -> tabular Workbook.
 *
 * Unzips the OOXML package with fflate, resolves the workbook and worksheet
 * parts through their relationship files, parses the SpreadsheetML, and
 * builds a dense, typed cell grid per sheet.
 */

import { Effect, Layer } from "effect";
import { strFromU8, unzipSync } from "fflate";
import {
  ParseError,
  Sheet,
  Workbook,
  cell,
  cellToString,
  contentToBytes,
  makeReaderTag,
  type Cell,
  type Content,
  type Reader,
} from "../../core/index.js";
import { parseA1 } from "./a1.js";
import { collectText, spreadsheetMlToCell } from "./cellTypes.js";
import {
  findChild,
  findChildren,
  getAttr,
  parseXml,
  type XmlElement,
} from "./xml.js";

const REL_OFFICE_DOCUMENT_SUFFIX = "/officeDocument";
const REL_WORKSHEET_SUFFIX = "/worksheet";
const REL_SHARED_STRINGS_SUFFIX = "/sharedStrings";

export interface XlsxReaderOptions {
  /**
   * Treat the first row of each sheet as column headers.
   * Defaults to false (all rows are data, lossless).
   */
  readonly firstRowAsHeader?: boolean;
}

// ============================================================================
// OOXML package navigation
// ============================================================================

interface XlsxArchive {
  readonly files: Record<string, Uint8Array>;
}

const readEntry = (archive: XlsxArchive, path: string): string | null => {
  // Normalize leading slashes ("/xl/workbook.xml" -> "xl/workbook.xml")
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
      if (content === null) {
        throw new Error(`Missing required package part: ${path}`);
      }
      return parseXml(content);
    },
    catch: (cause) =>
      new ParseError({
        format,
        reason: `Failed to parse "${path}": ${String(cause)}`,
        cause,
      }),
  });

/** Resolve a relationship target relative to a base directory */
const resolveTarget = (baseDir: string, target: string): string => {
  if (target.startsWith("/")) {
    return target.substring(1);
  }
  // Resolve "../" segments against the base directory
  const segments = [...baseDir.split("/").filter((s) => s !== ""), ...target.split("/")];
  const resolved: string[] = [];
  for (const segment of segments) {
    if (segment === "..") {
      resolved.pop();
    } else if (segment !== ".") {
      resolved.push(segment);
    }
  }
  return resolved.join("/");
};

/** Parse a .rels file into a map of relationship Id -> resolved target path */
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

interface ParsedSheet {
  readonly rows: ReadonlyArray<ReadonlyArray<Cell>>;
}

const parseWorksheet = (root: XmlElement, sharedStrings: ReadonlyArray<string>): ParsedSheet => {
  const sheetData = findChild(root, "sheetData");
  if (sheetData === undefined) {
    return { rows: [] };
  }

  // Sparse cell map: row -> col -> Cell
  const cellMap = new Map<number, Map<number, Cell>>();
  let maxRow = -1;
  let maxCol = -1;

  const rowElements = findChildren(sheetData, "row");
  for (const [rowOrdinal, rowEl] of rowElements.entries()) {
    // Row index from the r attribute (1-indexed), falling back to document order
    const rAttr = rowEl.attrs["r"];
    const rowIndex =
      rAttr !== undefined ? Number.parseInt(rAttr, 10) - 1 : rowOrdinal;

    for (const [colOrdinal, cellEl] of findChildren(rowEl, "c").entries()) {
      // Cell position from the r attribute (A1), falling back to document order
      const ref = cellEl.attrs["r"];
      const parsed = ref === undefined ? null : parseA1(ref);
      const colIndex = parsed === null ? colOrdinal : parsed.col;
      const effectiveRow = parsed === null ? rowIndex : parsed.row;

      const value = spreadsheetMlToCell(cellEl, sharedStrings);

      let rowCells = cellMap.get(effectiveRow);
      if (rowCells === undefined) {
        rowCells = new Map<number, Cell>();
        cellMap.set(effectiveRow, rowCells);
      }
      rowCells.set(colIndex, value);

      maxRow = Math.max(maxRow, effectiveRow);
      maxCol = Math.max(maxCol, colIndex);
    }

    maxRow = Math.max(maxRow, rowIndex);
  }

  if (maxRow < 0 || maxCol < 0) {
    return { rows: [] };
  }

  // Build a dense grid, filling gaps with null cells
  const rows: Cell[][] = [];
  for (let r = 0; r <= maxRow; r++) {
    const rowCells = cellMap.get(r);
    const row: Cell[] = [];
    for (let c = 0; c <= maxCol; c++) {
      row.push(rowCells?.get(c) ?? cell.empty());
    }
    rows.push(row);
  }

  return { rows };
};

// ============================================================================
// Reader
// ============================================================================

/**
 * Create an XLSX Reader with the given options baked in.
 */
export const makeXlsxReader = (options?: XlsxReaderOptions): Reader => {
  const firstRowAsHeader = options?.firstRowAsHeader ?? false;

  const readWorkbook = (input: Content): Effect.Effect<Workbook, ParseError> =>
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

      // 1. Root relationships -> workbook part
      const rootRels = yield* parseEntry(archive, "_rels/.rels", "xlsx");
      const workbookPath =
        parseRelationships(rootRels, "").find((rel) =>
          rel.type.endsWith(REL_OFFICE_DOCUMENT_SUFFIX)
        )?.target ?? "xl/workbook.xml";
      const workbookDir = workbookPath.substring(0, workbookPath.lastIndexOf("/"));

      // 2. Workbook relationships -> worksheet & shared string parts
      const workbookRelsPath = `${workbookDir}/_rels/${workbookPath.substring(workbookPath.lastIndexOf("/") + 1)}.rels`;
      const workbookRels = yield* parseEntry(archive, workbookRelsPath, "xlsx");
      const relationships = parseRelationships(workbookRels, workbookDir);

      // 3. Shared strings (optional part)
      const sharedStringsRel = relationships.find((rel) =>
        rel.type.endsWith(REL_SHARED_STRINGS_SUFFIX)
      );
      const sharedStrings: ReadonlyArray<string> =
        sharedStringsRel === undefined
          ? []
          : parseSharedStrings(
              yield* parseEntry(archive, sharedStringsRel.target, "xlsx")
            );

      // 4. Workbook -> ordered sheet list
      const workbookRoot = yield* parseEntry(archive, workbookPath, "xlsx");
      const sheetsEl = findChild(workbookRoot, "sheets");
      const sheetEntries = sheetsEl === undefined ? [] : findChildren(sheetsEl, "sheet");

      if (sheetEntries.length === 0) {
        return yield* new ParseError({
          format: "xlsx",
          reason: "Workbook contains no sheets",
        });
      }

      // 5. Parse each worksheet
      const sheets: Sheet[] = [];
      for (const sheetEl of sheetEntries) {
        const name = getAttr(sheetEl, "name") ?? `Sheet${sheets.length + 1}`;
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
        const { rows } = parseWorksheet(worksheetRoot, sharedStrings);

        const headers =
          firstRowAsHeader && rows.length > 0
            ? rows[0]!.map(cellToString)
            : null;
        const dataRows = firstRowAsHeader && rows.length > 0 ? rows.slice(1) : rows;

        sheets.push(new Sheet({ name, headers, rows: dataRows }));
      }

      const [first, ...rest] = sheets;
      return new Workbook({ sheets: [first!, ...rest] });
    });

  return {
    format: "xlsx",
    readWorkbook,
  };
};

/** Context tag for dependency-injection style usage */
export const XlsxReaderTag = makeReaderTag("xlsx");

/** Layer providing an XLSX Reader with default options */
export const XlsxReaderLive = Layer.succeed(XlsxReaderTag, makeXlsxReader());

/** Layer providing an XLSX Reader with custom options */
export const makeXlsxReaderLayer = (options?: XlsxReaderOptions) =>
  Layer.succeed(XlsxReaderTag, makeXlsxReader(options));
