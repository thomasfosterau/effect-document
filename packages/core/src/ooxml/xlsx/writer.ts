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
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import {
  bytes,
  type Content,
  type Diagnostic,
  type Doc,
  logDiagnostics,
  makeWriterTag,
  rowCellsOf,
  rowEntries,
  isPlainRow,
  rowIndexes,
  type SheetCell,
  sheetExtent,
  type Worksheet,
  WriteError,
  type Writer,
} from "../../index.ts";
import { Xlsx, type XlsxFeature } from "./profile.ts";
import { toA1 } from "./a1.ts";
import { NON_FINITE_CELL, SharedStrings, cellToSpreadsheetMl, escapeXstring } from "./cellTypes.ts";
import {
  type CellHyperlink,
  cellHyperlink,
  hyperlinksXml,
  type HyperlinksXml,
  REL_HYPERLINK,
  widenedDiagnostic,
} from "./hyperlinks.ts";
import { NS_CONTENT_TYPES, NS_PKG_REL, NS_REL_DOC, XML_DECL, zipParts } from "../shared/index.ts";
import { escapeAttr } from "./xml.ts";
import { colsXml, mergeCellsXml } from "./layout.ts";

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

/** Characters a sheet name may not contain: `[]:*?/\` and the C0 controls. */
// oxlint-disable-next-line eslint/no-control-regex -- the C0 controls are among the characters a sheet name forbids
const SHEET_NAME_FORBIDDEN = /[[\]:*?/\\\u0000-\u001F]/g;

/**
 * Make sheet names Excel accepts, deterministically: `[ ] : * ? / \` and
 * control characters become `_`, leading/trailing apostrophes are dropped, empty names become
 * `Sheet<n>`, the reserved `History` gets a suffix, names are cut to 31
 * characters, and case-insensitive duplicates are numbered ("Data (2)").
 */
export const sanitizeSheetNames = (names: ReadonlyArray<string>): ReadonlyArray<string> => {
  const used = new Set<string>();
  return names.map((raw, i) => {
    let base = raw.replace(SHEET_NAME_FORBIDDEN, "_").replace(/^'+|'+$/g, "");
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

/** The diagnostic for a sheet whose name `sanitizeSheetNames` changed (#112). */
const renamedSheets = (
  names: ReadonlyArray<string>,
  written: ReadonlyArray<string>,
): Array<Diagnostic> =>
  names.flatMap((name, i) => {
    const as = written[i] ?? name;
    return as === name
      ? []
      : [
          {
            format: "xlsx",
            stage: "write",
            code: "xlsx.sheetRenamed",
            severity: "converted",
            path: [name],
            detail: `sheet "${name}" written as "${as}", a name Excel accepts`,
          } as const,
        ];
  });

/** The diagnostic for a number cell SpreadsheetML cannot hold, written as `#NUM!` (#112). */
const nonFinite = (sheet: string, address: string, cell: SheetCell): Diagnostic => ({
  format: "xlsx",
  stage: "write",
  code: "xlsx.nonFiniteNumber",
  severity: "converted",
  path: [sheet, address],
  detail: `${Predicate.isTagged(cell, "CellNumber") ? String(cell.value) : "a number"} in ${sheet}!${address} written as #NUM!`,
});

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
    .map((s) =>
      Predicate.isString(s)
        ? `<si><t xml:space="preserve">${escapeXstring(s)}</t></si>`
        : `<si>${s.runsXml}</si>`,
    )
    .join("");
  return (
    XML_DECL +
    `<sst xmlns="${NS_MAIN}" count="${table.count}" uniqueCount="${strings.length}">` +
    items +
    `</sst>`
  );
};

/** A worksheet's part, and the relationships its hyperlinks need (#67). */
interface SheetPart {
  readonly xml: string;
  readonly rels: HyperlinksXml["rels"];
}

/** A worksheet part's `_rels` part, for its external hyperlinks. */
const sheetRelsXml = (rels: SheetPart["rels"]): string =>
  XML_DECL +
  `<Relationships xmlns="${NS_PKG_REL}">` +
  rels
    .map(
      ({ id, url }) =>
        `<Relationship Id="${id}" Type="${REL_HYPERLINK}" Target="${escapeAttr(url)}" TargetMode="External"/>`,
    )
    .join("") +
  `</Relationships>`;

/**
 * A worksheet's part. A `NaN` or `±Infinity` number, which SpreadsheetML
 * cannot hold, is written as `#NUM!` and reported in `notes` (#112), as is a
 * rich cell whose link covers only part of it, which is written linked whole
 * (#67).
 */
const worksheetXml = (
  ws: Worksheet,
  sharedStrings: SharedStrings,
  merges: string,
  notes: Array<Diagnostic>,
): SheetPart => {
  const links: Array<CellHyperlink> = [];
  // The worksheet is sparse, as SpreadsheetML is: each row and cell goes out
  // at its own index, and blank cells emit no <c>. <dimension> declares the
  // extent of the cells the sheet holds.
  const extent = sheetExtent(ws);
  const dimension =
    extent.rows === 0 || extent.columns === 0
      ? ""
      : `<dimension ref="A1:${toA1(extent.columns - 1, extent.rows - 1)}"/>`;
  const indexes = rowIndexes(ws);
  const rows = ws.rows
    .map((row, i) => {
      const index = indexes[i] ?? i;
      const cells = rowEntries(row).flatMap(([col, cell]) => {
        const rendered = cellToSpreadsheetMl(cell, sharedStrings);
        if (rendered === null) return [];
        if (rendered === NON_FINITE_CELL) notes.push(nonFinite(ws.name, toA1(col, index), cell));
        const link = Predicate.isTagged(cell, "CellRichText")
          ? cellHyperlink(cell, toA1(col, index))
          : Option.none();
        if (Option.isSome(link)) {
          links.push(link.value);
          if (link.value.widened) notes.push(widenedDiagnostic(ws.name, link.value.ref));
        }
        const typeAttr = rendered.type === null ? "" : ` t="${rendered.type}"`;
        return [`<c r="${toA1(col, index)}"${typeAttr}>${rendered.inner}</c>`];
      });
      const height = isPlainRow(row) ? undefined : row.height;
      const ht = height === undefined ? "" : ` ht="${height}" customHeight="1"`;
      return `<row r="${index + 1}"${ht}>${cells.join("")}</row>`;
    })
    .join("");
  const hyperlinks = hyperlinksXml(links, escapeAttr);
  const ns = hyperlinks.xml === "" ? "" : ` xmlns:r="${NS_REL_DOC}"`;
  return {
    xml:
      XML_DECL +
      `<worksheet xmlns="${NS_MAIN}"${ns}>${dimension}${colsXml(ws.columns)}<sheetData>${rows}</sheetData>${merges}${hyperlinks.xml}</worksheet>`,
    rels: hyperlinks.rels,
  };
};

/** Whether a row's height can be written: none, or a finite, non-negative number of points. */
const isRowHeight = (height: number | undefined): boolean =>
  height === undefined || (Number.isFinite(height) && height >= 0);

// ============================================================================
// Writer
// ============================================================================

/** Options for the XLSX writer. */
export interface XlsxWriterOptions {
  /** Zip compression level 0-9 (defaults to 6). */
  readonly compressionLevel?: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | undefined;
}

/** Create an XLSX Writer with the given options baked in. */
export const makeXlsxWriter = (options?: XlsxWriterOptions): Writer<XlsxFeature> => {
  const level = options?.compressionLevel ?? 6;

  const write = (doc: Doc<XlsxFeature>): Effect.Effect<Content, WriteError> => {
    const worksheets = doc.blocks.filter((b): b is Worksheet => Predicate.isTagged(b, "Worksheet"));
    if (Arr.isReadonlyArrayEmpty(worksheets))
      return Effect.fail(
        new WriteError({ format: "xlsx", reason: "document contains no worksheets to write" }),
      );
    const badHeight = worksheets.find((ws) =>
      ws.rows.some((row) => !isPlainRow(row) && !isRowHeight(row.height)),
    );
    if (badHeight !== undefined)
      return Effect.fail(
        new WriteError({
          format: "xlsx",
          reason: `worksheet "${badHeight.name}" has a row height that is not a finite, non-negative number of points`,
        }),
      );
    const merges = Result.all(worksheets.map((ws) => mergeCellsXml(ws.merges)));
    if (Result.isFailure(merges))
      return Effect.fail(new WriteError({ format: "xlsx", reason: merges.failure }));
    return Effect.try({
      try: () => {
        const sharedStrings = new SharedStrings();
        const names = worksheets.map((w) => w.name);
        const sheetNames = sanitizeSheetNames(names);
        const notes = renamedSheets(names, sheetNames);
        const sheetXmls = worksheets.map((ws, i) =>
          worksheetXml(ws, sharedStrings, merges.success[i] ?? "", notes),
        );

        const recalculate = worksheets.some((ws) =>
          ws.rows.some((row) =>
            rowCellsOf(row).some(
              (cell) => Predicate.isTagged(cell, "CellFormula") && cell.result === undefined,
            ),
          ),
        );

        const files = {
          "[Content_Types].xml": contentTypesXml(worksheets.length),
          "_rels/.rels": rootRelsXml(),
          "docProps/core.xml": corePropsXml(),
          "docProps/app.xml": appPropsXml(),
          "xl/workbook.xml": workbookXml(sheetNames, recalculate),
          "xl/_rels/workbook.xml.rels": workbookRelsXml(worksheets.length),
          "xl/sharedStrings.xml": sharedStringsXml(sharedStrings),
          ...Object.fromEntries(
            sheetXmls.flatMap((part, i) => {
              const sheet = [`xl/worksheets/sheet${i + 1}.xml`, part.xml] as const;
              return Arr.isReadonlyArrayEmpty(part.rels)
                ? [sheet]
                : [
                    sheet,
                    [
                      `xl/worksheets/_rels/sheet${i + 1}.xml.rels`,
                      sheetRelsXml(part.rels),
                    ] as const,
                  ];
            }),
          ),
        };

        return [bytes(zipParts(files, level)), notes] as const;
      },
      catch: (cause) =>
        new WriteError({
          format: "xlsx",
          reason: `Failed to generate xlsx package: ${String(cause)}`,
          cause,
        }),
    }).pipe(Effect.flatMap(([content, notes]) => Effect.as(logDiagnostics(notes), content)));
  };

  return { format: "xlsx", profile: Xlsx, write };
};

/** Context tag for dependency-injection style usage. */
export const XlsxWriterTag = makeWriterTag<XlsxFeature>("xlsx");

/** Layer providing an XLSX Writer with default options. */
export const XlsxWriterLive = Layer.succeed(XlsxWriterTag, makeXlsxWriter());

/** Layer providing an XLSX Writer with custom options. */
export const makeXlsxWriterLayer = (options?: XlsxWriterOptions) =>
  Layer.succeed(XlsxWriterTag, makeXlsxWriter(options));
