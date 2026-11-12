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
import * as Option from "effect/Option";
import {
  type Content,
  contentToBytes,
  type Doc,
  document,
  makeReaderTag,
  ParseError,
  type Reader,
  worksheetFromRows,
  trustAs,
  Worksheet,
} from "../../index.ts";
import { collectText } from "./cellTypes.ts";
import { OpcError, type OpcLimits, OpcReader, ooxmlParseError } from "../shared/index.ts";
import { findChild, findChildren, getAttr, type XmlElement } from "./xml.ts";
import { parseWithScannedContent } from "../shared/xml.ts";
import { parseWorksheetRows, type WorksheetRows } from "./rows.ts";
import { scanSheetData } from "./sheetData.ts";

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

/**
 * A required part, parsed; failures keep the part name and XML position.
 * `fastContentOf` names an element whose content is read by the XML layer's
 * fast scanner (a worksheet's `sheetData`).
 */
const parsePart = (
  pkg: OpcReader,
  path: string,
  fastContentOf?: string,
): Effect.Effect<XmlElement, ParseError> =>
  Effect.try({
    try: () => {
      const root = pkg.xml(path, fastContentOf);
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

/**
 * A worksheet part's rows: its `sheetData` read straight into rows by
 * {@link scanSheetData} when the scanner can (the rest of the part still
 * parsed and checked), or else the part parsed into a tree and its rows read
 * from that, which every unusual sheet takes.
 */
const readWorksheetRows = (
  pkg: OpcReader,
  target: string,
  sharedStrings: ReadonlyArray<string>,
  maxCells: number,
): Effect.Effect<WorksheetRows, ParseError> =>
  Effect.flatMap(
    Effect.try({
      try: () => {
        const text = pkg.text(target);
        return text === null
          ? Option.none()
          : Option.filter(
              parseWithScannedContent(text, "sheetData", (xml, from) =>
                scanSheetData(xml, from, sharedStrings, maxCells),
              ),
              // the rows the tree path reads: the root's first sheetData
              ({ root, target: scanned }) => findChild(root, "sheetData") === scanned,
            );
      },
      catch: (cause) => ooxmlParseError("xlsx", cause),
    }),
    Option.match({
      onSome: ({ value }) => Effect.succeed(value),
      onNone: () =>
        Effect.map(parsePart(pkg, target, "sheetData"), (root) =>
          parseWorksheetRows(root, sharedStrings, maxCells),
        ),
    }),
  );

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
        return yield* new ParseError({
          format: "xlsx",
          reason: "Workbook contains no sheets",
          code: "MissingPart",
        });
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

            if (relId === undefined || relId === "") {
              // The workbook lists the sheet but links no part to it (a VBA
              // module LibreOffice left behind, Apache POI bug 60825): there
              // is nothing to read, so keep its place and name as an empty
              // sheet tagged as unlinked, rather than failing the workbook.
              return new Worksheet({
                attr: { data: { kind: "unlinked" } },
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
                code: "MissingPart",
                position: { sheet: name },
              });
            }

            const remaining = maxCells - allocated;
            const parsed = yield* readWorksheetRows(pkg, target, sharedStrings, remaining);
            if (Predicate.isTagged(parsed, "TooLarge")) {
              return yield* new ParseError({
                format: "xlsx",
                reason:
                  `Worksheet "${name}" holds more than the ${remaining} cells left of the ` +
                  `workbook's ${maxCells}-cell limit (maxCells)`,
                code: "LimitExceeded",
                position: { sheet: name, part: target },
              });
            }
            allocated += parsed.cells;
            return worksheetFromRows(name, parsed.rows);
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
