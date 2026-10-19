/**
 * The XLSX Reader: .xlsx bytes -> a multi-worksheet document in the Spreadsheet
 * profile.
 *
 * Unzips the OOXML package with fflate, resolves the workbook and worksheet
 * parts through their relationship files, parses the SpreadsheetML, and builds
 * a dense, typed cell grid per sheet.
 */

import { Effect, Layer } from "effect";
import { strFromU8, unzipSync } from "fflate";
import {
  cell, type Content, contentToBytes, type Doc, document, type FeaturesOf, makeReaderTag,
  ParseError, type Reader, type SheetCell, SheetRow, trustAs, Worksheet,
} from "@thomasfosterau/effect-document";
import { Spreadsheet } from "@thomasfosterau/effect-document/profiles";
import { parseA1 } from "./a1.js";
import { collectText, spreadsheetMlToCell } from "./cellTypes.js";
import { findChild, findChildren, getAttr, parseXml, type XmlElement } from "./xml.js";

export type SpreadsheetFeature = FeaturesOf<typeof Spreadsheet>;

const REL_OFFICE_DOCUMENT_SUFFIX = "/officeDocument";
const REL_WORKSHEET_SUFFIX = "/worksheet";
const REL_SHARED_STRINGS_SUFFIX = "/sharedStrings";

export interface XlsxReaderOptions {
  /** Reserved for future reader options. */
  readonly _?: never;
}

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

const parseWorksheetRows = (
  root: XmlElement,
  sharedStrings: ReadonlyArray<string>
): ReadonlyArray<ReadonlyArray<SheetCell>> => {
  const sheetData = findChild(root, "sheetData");
  if (sheetData === undefined) return [];

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

      const value = spreadsheetMlToCell(cellEl, sharedStrings);

      let rowCells = cellMap.get(effectiveRow);
      if (rowCells === undefined) {
        rowCells = new Map<number, SheetCell>();
        cellMap.set(effectiveRow, rowCells);
      }
      rowCells.set(colIndex, value);

      maxRow = Math.max(maxRow, effectiveRow);
      maxCol = Math.max(maxCol, colIndex);
    }

    maxRow = Math.max(maxRow, rowIndex);
  }

  if (maxRow < 0 || maxCol < 0) return [];

  const rows: SheetCell[][] = [];
  for (let r = 0; r <= maxRow; r++) {
    const rowCells = cellMap.get(r);
    const row: SheetCell[] = [];
    for (let c = 0; c <= maxCol; c++) row.push(rowCells?.get(c) ?? cell.blank());
    rows.push(row);
  }
  return rows;
};

// ============================================================================
// Reader
// ============================================================================

/** Create an XLSX Reader with the given options baked in. */
export const makeXlsxReader = (_options?: XlsxReaderOptions): Reader<SpreadsheetFeature> => {
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
        const rows = parseWorksheetRows(worksheetRoot, sharedStrings);
        worksheets.push(
          new Worksheet({
            name,
            columns: [],
            rows: rows.map((cells) => new SheetRow({ cells })),
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
