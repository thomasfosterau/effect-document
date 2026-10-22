/**
 * The XLSX Writer: an XLSX-profile document -> .xlsx bytes.
 *
 * Generates a minimal but valid OOXML spreadsheet package (workbook,
 * worksheets, shared strings, content types, relationships) and zips it with
 * fflate. The input type guarantees only worksheet blocks reach the writer.
 */

import * as Predicate from "effect/Predicate";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  bytes,
  type Content,
  type Doc,
  makeWriterTag,
  type Worksheet,
  WriteError,
  type Writer,
} from "@thomasfosterau/effect-document";
import { Xlsx, type XlsxFeature } from "./profile.ts";
import { toA1 } from "./a1.ts";
import { SharedStrings, cellToSpreadsheetMl, escapeXstring } from "./cellTypes.ts";
import { NS_CONTENT_TYPES, NS_PKG_REL, NS_REL_DOC, XML_DECL, zipParts } from "../shared/index.ts";
import { escapeAttr } from "./xml.ts";

const NS_MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";

const CT_WORKBOOK = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml";
const CT_WORKSHEET = "application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml";
const CT_SHARED_STRINGS =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml";
const CT_RELS = "application/vnd.openxmlformats-package.relationships+xml";
const CT_CORE_PROPS = "application/vnd.openxmlformats-package.core-properties+xml";
const CT_APP_PROPS = "application/vnd.openxmlformats-officedocument.extended-properties+xml";

const REL_OFFICE_DOCUMENT =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument";
const REL_WORKSHEET =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet";
const REL_SHARED_STRINGS =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings";
const REL_CORE_PROPS =
  "http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties";
const REL_APP_PROPS =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties";

// ============================================================================
// Sheet names
// ============================================================================

const MAX_SHEET_NAME = 31;

/** Truncate to `max` UTF-16 units without splitting a surrogate pair. */
const truncate = (s: string, max: number): string => {
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
};

/**
 * Make sheet names Excel accepts, deterministically: `[ ] : * ? / \` and
 * control characters become `_`, leading/trailing apostrophes are dropped, empty names become
 * `Sheet<n>`, the reserved `History` gets a suffix, names are cut to 31
 * characters, and case-insensitive duplicates are numbered ("Data (2)").
 */
export const sanitizeSheetNames = (names: ReadonlyArray<string>): ReadonlyArray<string> => {
  const used = new Set<string>();
  return names.map((raw, i) => {
    let base = raw.replace(/[[\]:*?/\\\u0000-\u001F]/g, "_").replace(/^'+|'+$/g, "");
    if (base === "") base = `Sheet${i + 1}`;
    if (base.toLowerCase() === "history") base = `${base}_`;
    base = truncate(base, MAX_SHEET_NAME);
    let name = base;
    for (let n = 2; used.has(name.toLowerCase()); n++) {
      const suffix = ` (${n})`;
      name = truncate(base, MAX_SHEET_NAME - suffix.length) + suffix;
    }
    used.add(name.toLowerCase());
    return name;
  });
};

// ============================================================================
// Part generation
// ============================================================================

const contentTypesXml = (sheetCount: number): string => {
  const overrides = Array.from(
    { length: sheetCount },
    (_, i) =>
      `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="${CT_WORKSHEET}"/>`,
  ).join("");
  return (
    XML_DECL +
    `<Types xmlns="${NS_CONTENT_TYPES}">` +
    `<Default Extension="rels" ContentType="${CT_RELS}"/>` +
    `<Default Extension="xml" ContentType="application/xml"/>` +
    `<Override PartName="/xl/workbook.xml" ContentType="${CT_WORKBOOK}"/>` +
    overrides +
    `<Override PartName="/xl/sharedStrings.xml" ContentType="${CT_SHARED_STRINGS}"/>` +
    `<Override PartName="/docProps/core.xml" ContentType="${CT_CORE_PROPS}"/>` +
    `<Override PartName="/docProps/app.xml" ContentType="${CT_APP_PROPS}"/>` +
    `</Types>`
  );
};

const rootRelsXml = (): string =>
  XML_DECL +
  `<Relationships xmlns="${NS_PKG_REL}">` +
  `<Relationship Id="rId1" Type="${REL_OFFICE_DOCUMENT}" Target="xl/workbook.xml"/>` +
  `<Relationship Id="rId2" Type="${REL_CORE_PROPS}" Target="docProps/core.xml"/>` +
  `<Relationship Id="rId3" Type="${REL_APP_PROPS}" Target="docProps/app.xml"/>` +
  `</Relationships>`;

const corePropsXml = (): string =>
  XML_DECL +
  `<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties"` +
  ` xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/"` +
  ` xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"/>`;

const appPropsXml = (): string =>
  XML_DECL +
  `<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties">` +
  `<Application>effect-document</Application>` +
  `</Properties>`;

const workbookXml = (sheetNames: ReadonlyArray<string>, recalculate: boolean): string => {
  const sheets = sheetNames
    .map((name, i) => `<sheet name="${escapeAttr(name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
    .join("");
  return (
    XML_DECL +
    `<workbook xmlns="${NS_MAIN}" xmlns:r="${NS_REL_DOC}">` +
    `<sheets>${sheets}</sheets>` +
    // Formulas without a cached result would show blank until recalculated.
    (recalculate ? `<calcPr fullCalcOnLoad="1"/>` : "") +
    `</workbook>`
  );
};

const workbookRelsXml = (sheetCount: number): string => {
  const sheetRels = Array.from(
    { length: sheetCount },
    (_, i) =>
      `<Relationship Id="rId${i + 1}" Type="${REL_WORKSHEET}" Target="worksheets/sheet${i + 1}.xml"/>`,
  ).join("");
  return (
    XML_DECL +
    `<Relationships xmlns="${NS_PKG_REL}">` +
    sheetRels +
    `<Relationship Id="rId${sheetCount + 1}" Type="${REL_SHARED_STRINGS}" Target="sharedStrings.xml"/>` +
    `</Relationships>`
  );
};

const sharedStringsXml = (table: SharedStrings): string => {
  const strings = table.strings;
  const items = strings
    .map((s) => `<si><t xml:space="preserve">${escapeXstring(s)}</t></si>`)
    .join("");
  return (
    XML_DECL +
    `<sst xmlns="${NS_MAIN}" count="${table.count}" uniqueCount="${strings.length}">` +
    items +
    `</sst>`
  );
};

const worksheetXml = (ws: Worksheet, sharedStrings: SharedStrings): string => {
  // Blank cells emit no <c>, so the full grid size (including trailing blank
  // rows and columns) is declared in <dimension> for the reader to recover.
  const maxCols = ws.rows.reduce((m, r) => Math.max(m, r.cells.length), 0);
  const dimension =
    Arr.isReadonlyArrayEmpty(ws.rows) || maxCols === 0
      ? ""
      : `<dimension ref="A1:${toA1(maxCols - 1, ws.rows.length - 1)}"/>`;
  const rows = ws.rows
    .map((row, rowIndex) => {
      const cells: string[] = [];
      for (let colIndex = 0; colIndex < row.cells.length; colIndex++) {
        const rendered = cellToSpreadsheetMl(row.cells[colIndex]!, sharedStrings);
        if (rendered === null) continue;
        const typeAttr = rendered.type === null ? "" : ` t="${rendered.type}"`;
        cells.push(`<c r="${toA1(colIndex, rowIndex)}"${typeAttr}>${rendered.inner}</c>`);
      }
      return `<row r="${rowIndex + 1}">${cells.join("")}</row>`;
    })
    .join("");
  return (
    XML_DECL +
    `<worksheet xmlns="${NS_MAIN}">${dimension}<sheetData>${rows}</sheetData></worksheet>`
  );
};

// ============================================================================
// Writer
// ============================================================================

export interface XlsxWriterOptions {
  /** Zip compression level 0-9 (defaults to 6). */
  readonly compressionLevel?: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | undefined;
}

/** Create an XLSX Writer with the given options baked in. */
export const makeXlsxWriter = (options?: XlsxWriterOptions): Writer<XlsxFeature> => {
  const level = options?.compressionLevel ?? 6;

  const write = (doc: Doc<XlsxFeature>): Effect.Effect<Content, WriteError> =>
    Effect.try({
      try: () => {
        const worksheets = doc.blocks.filter((b): b is Worksheet =>
          Predicate.isTagged(b, "Worksheet"),
        );
        if (Arr.isReadonlyArrayEmpty(worksheets)) {
          throw new Error("document contains no worksheets to write");
        }

        const sharedStrings = new SharedStrings();
        const sheetXmls = worksheets.map((ws) => worksheetXml(ws, sharedStrings));

        const recalculate = worksheets.some((ws) =>
          ws.rows.some((row) =>
            row.cells.some((c) => Predicate.isTagged(c, "CellFormula") && c.result === undefined),
          ),
        );

        const files: Record<string, string> = {
          "[Content_Types].xml": contentTypesXml(worksheets.length),
          "_rels/.rels": rootRelsXml(),
          "docProps/core.xml": corePropsXml(),
          "docProps/app.xml": appPropsXml(),
          "xl/workbook.xml": workbookXml(
            sanitizeSheetNames(worksheets.map((w) => w.name)),
            recalculate,
          ),
          "xl/_rels/workbook.xml.rels": workbookRelsXml(worksheets.length),
          "xl/sharedStrings.xml": sharedStringsXml(sharedStrings),
        };
        sheetXmls.forEach((xml, i) => {
          files[`xl/worksheets/sheet${i + 1}.xml`] = xml;
        });

        return bytes(zipParts(files, level));
      },
      catch: (cause) =>
        new WriteError({
          format: "xlsx",
          reason: `Failed to generate xlsx package: ${String(cause)}`,
          cause,
        }),
    });

  return { format: "xlsx", profile: Xlsx, write };
};

/** Context tag for dependency-injection style usage. */
export const XlsxWriterTag = makeWriterTag<XlsxFeature>("xlsx");

/** Layer providing an XLSX Writer with default options. */
export const XlsxWriterLive = Layer.succeed(XlsxWriterTag, makeXlsxWriter());

/** Layer providing an XLSX Writer with custom options. */
export const makeXlsxWriterLayer = (options?: XlsxWriterOptions) =>
  Layer.succeed(XlsxWriterTag, makeXlsxWriter(options));
