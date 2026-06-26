/**
 * The XLSX Writer: tabular Workbook -> .xlsx bytes.
 *
 * Generates a minimal but valid OOXML spreadsheet package (workbook,
 * worksheets, shared strings, content types, relationships) and zips it with
 * fflate. No styles, formulas, or number formats - see cellTypes.ts for the
 * cell mapping.
 */

import { Effect, Layer } from "effect";
import { strToU8, zipSync } from "fflate";
import {
  WriteError,
  bytes,
  makeWriterTag,
  type Content,
  type Sheet,
  type Workbook,
  type Writer,
} from "../core/index.js";
import { toA1 } from "./a1.js";
import { SharedStrings, cellToSpreadsheetMl } from "./cellTypes.js";
import { escapeAttr, escapeXml } from "./xml.js";

const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

const NS_MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const NS_REL_DOC =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const NS_PKG_REL =
  "http://schemas.openxmlformats.org/package/2006/relationships";
const NS_CONTENT_TYPES =
  "http://schemas.openxmlformats.org/package/2006/content-types";

const CT_WORKBOOK =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml";
const CT_WORKSHEET =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml";
const CT_SHARED_STRINGS =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml";
const CT_RELS = "application/vnd.openxmlformats-package.relationships+xml";

const REL_OFFICE_DOCUMENT =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument";
const REL_WORKSHEET =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet";
const REL_SHARED_STRINGS =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings";

// ============================================================================
// Part generation
// ============================================================================

const contentTypesXml = (sheetCount: number): string => {
  const overrides = Array.from(
    { length: sheetCount },
    (_, i) =>
      `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="${CT_WORKSHEET}"/>`
  ).join("");

  return (
    XML_DECL +
    `<Types xmlns="${NS_CONTENT_TYPES}">` +
    `<Default Extension="rels" ContentType="${CT_RELS}"/>` +
    `<Default Extension="xml" ContentType="application/xml"/>` +
    `<Override PartName="/xl/workbook.xml" ContentType="${CT_WORKBOOK}"/>` +
    overrides +
    `<Override PartName="/xl/sharedStrings.xml" ContentType="${CT_SHARED_STRINGS}"/>` +
    `</Types>`
  );
};

const rootRelsXml = (): string =>
  XML_DECL +
  `<Relationships xmlns="${NS_PKG_REL}">` +
  `<Relationship Id="rId1" Type="${REL_OFFICE_DOCUMENT}" Target="xl/workbook.xml"/>` +
  `</Relationships>`;

const workbookXml = (sheetNames: ReadonlyArray<string>): string => {
  const sheets = sheetNames
    .map(
      (name, i) =>
        `<sheet name="${escapeAttr(name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`
    )
    .join("");

  return (
    XML_DECL +
    `<workbook xmlns="${NS_MAIN}" xmlns:r="${NS_REL_DOC}">` +
    `<sheets>${sheets}</sheets>` +
    `</workbook>`
  );
};

const workbookRelsXml = (sheetCount: number): string => {
  const sheetRels = Array.from(
    { length: sheetCount },
    (_, i) =>
      `<Relationship Id="rId${i + 1}" Type="${REL_WORKSHEET}" Target="worksheets/sheet${i + 1}.xml"/>`
  ).join("");

  return (
    XML_DECL +
    `<Relationships xmlns="${NS_PKG_REL}">` +
    sheetRels +
    `<Relationship Id="rId${sheetCount + 1}" Type="${REL_SHARED_STRINGS}" Target="sharedStrings.xml"/>` +
    `</Relationships>`
  );
};

const sharedStringsXml = (strings: ReadonlyArray<string>): string => {
  const items = strings
    .map((s) => `<si><t xml:space="preserve">${escapeXml(s)}</t></si>`)
    .join("");

  return (
    XML_DECL +
    `<sst xmlns="${NS_MAIN}" count="${strings.length}" uniqueCount="${strings.length}">` +
    items +
    `</sst>`
  );
};

const worksheetXml = (sheet: Sheet, sharedStrings: SharedStrings): string => {
  // Headers (if any) are written as the first row of shared strings,
  // data rows follow.
  const renderHeaderRow = (
    headers: ReadonlyArray<string>,
    rowIndex: number
  ): string => {
    const rendered = headers
      .map((value, colIndex) => {
        const index = sharedStrings.intern(value);
        return `<c r="${toA1(colIndex, rowIndex)}" t="s"><v>${index}</v></c>`;
      })
      .join("");
    return `<row r="${rowIndex + 1}">${rendered}</row>`;
  };

  const rows: string[] = [];
  let rowIndex = 0;

  if (sheet.headers !== null) {
    rows.push(renderHeaderRow(sheet.headers, rowIndex));
    rowIndex++;
  }

  for (const dataRow of sheet.rows) {
    const cells = dataRow
      .map((c, colIndex) => {
        const rendered = cellToSpreadsheetMl(c, sharedStrings);
        if (rendered === null) {
          return "";
        }
        const typeAttr = rendered.type === null ? "" : ` t="${rendered.type}"`;
        return `<c r="${toA1(colIndex, rowIndex)}"${typeAttr}>${rendered.inner}</c>`;
      })
      .join("");
    rows.push(`<row r="${rowIndex + 1}">${cells}</row>`);
    rowIndex++;
  }

  return (
    XML_DECL +
    `<worksheet xmlns="${NS_MAIN}">` +
    `<sheetData>${rows.join("")}</sheetData>` +
    `</worksheet>`
  );
};

// ============================================================================
// Writer
// ============================================================================

export interface XlsxWriterOptions {
  /** Zip compression level 0-9 (defaults to 6) */
  readonly compressionLevel?: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;
}

/**
 * Create an XLSX Writer with the given options baked in.
 */
export const makeXlsxWriter = (options?: XlsxWriterOptions): Writer => {
  const level = options?.compressionLevel ?? 6;

  const writeWorkbook = (
    workbook: Workbook
  ): Effect.Effect<Content, WriteError> =>
    Effect.try({
      try: () => {
        const sharedStrings = new SharedStrings();

        // Render worksheets first so the shared strings table is populated
        const worksheets = workbook.sheets.map((sheet) =>
          worksheetXml(sheet, sharedStrings)
        );

        const files: Record<string, Uint8Array> = {
          "[Content_Types].xml": strToU8(
            contentTypesXml(workbook.sheets.length)
          ),
          "_rels/.rels": strToU8(rootRelsXml()),
          "xl/workbook.xml": strToU8(
            workbookXml(workbook.sheets.map((s) => s.name))
          ),
          "xl/_rels/workbook.xml.rels": strToU8(
            workbookRelsXml(workbook.sheets.length)
          ),
          "xl/sharedStrings.xml": strToU8(
            sharedStringsXml(sharedStrings.strings)
          ),
        };

        worksheets.forEach((xml, i) => {
          files[`xl/worksheets/sheet${i + 1}.xml`] = strToU8(xml);
        });

        return bytes(zipSync(files, { level }));
      },
      catch: (cause) =>
        new WriteError({
          format: "xlsx",
          reason: `Failed to generate xlsx package: ${String(cause)}`,
          cause,
        }),
    });

  return {
    format: "xlsx",
    writeWorkbook,
  };
};

/** Context tag for dependency-injection style usage */
export const XlsxWriterTag = makeWriterTag("xlsx");

/** Layer providing an XLSX Writer with default options */
export const XlsxWriterLive = Layer.succeed(XlsxWriterTag, makeXlsxWriter());

/** Layer providing an XLSX Writer with custom options */
export const makeXlsxWriterLayer = (options?: XlsxWriterOptions) =>
  Layer.succeed(XlsxWriterTag, makeXlsxWriter(options));
