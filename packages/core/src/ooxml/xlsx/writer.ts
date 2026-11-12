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
  breaksWhole,
  bytes,
  type Content,
  type Diagnostic,
  type Doc,
  isThreadComment,
  logDiagnostics,
  makeWriterTag,
  rowCellsOf,
  rowEntries,
  isPlainRow,
  rowIndexes,
  type SheetCell,
  sheetExtent,
  type SheetVisibility,
  type Worksheet,
  WriteError,
  type Writer,
} from "../../index.ts";
import { Xlsx, type XlsxFeature } from "./profile.ts";
import { toA1 } from "./a1.ts";
import { NON_FINITE_CELL, SharedStrings, cellToSpreadsheetMl, escapeXstring } from "./cellTypes.ts";
import { type CellHyperlink, cellHyperlink, hyperlinksXml, REL_HYPERLINK } from "./hyperlinks.ts";
import {
  metadataDiagnostics,
  NS_CONTENT_TYPES,
  NS_PKG_REL,
  NS_REL_DOC,
  PROPS_CONTENT_TYPES,
  propsParts,
  propsRelationships,
  XML_DECL,
  zipParts,
} from "../shared/index.ts";
import { escapeAttr } from "./xml.ts";
import { colsXml, mergeCellsXml } from "./layout.ts";
import {
  commentPeople,
  CT_COMMENTS,
  CT_PERSONS,
  CT_THREADED_COMMENTS,
  CT_VML_DRAWING,
  type CommentsXml,
  commentsXml,
  personsXml,
  REL_COMMENTS,
  REL_PERSONS,
  REL_THREADED_COMMENTS,
  REL_VML_DRAWING,
  reshapedDiagnostic,
  unkeptDiagnostic,
} from "./comments.ts";

const NS_MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";

const CT_WORKBOOK = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml";
const CT_WORKSHEET = "application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml";
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

/**
 * `[Content_Types].xml`: the sheets, and, for the `commentParts` sheets that
 * have comments (numbered from 1), their comments parts and the `vml`
 * extension of the drawings that show them, and, for the `threadedParts`
 * sheets with threads, their threaded comments and the workbook's people.
 */
const contentTypesXml = (
  sheetCount: number,
  commentParts: number,
  threadedParts: number,
): string => {
  const overrides =
    Array.from(
      { length: sheetCount },
      (_, i) =>
        `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="${CT_WORKSHEET}"/>`,
    ).join("") +
    Array.from(
      { length: commentParts },
      (_, i) => `<Override PartName="/xl/comments${i + 1}.xml" ContentType="${CT_COMMENTS}"/>`,
    ).join("") +
    Array.from(
      { length: threadedParts },
      (_, i) =>
        `<Override PartName="/xl/threadedComments/threadedComment${i + 1}.xml" ContentType="${CT_THREADED_COMMENTS}"/>`,
    ).join("") +
    (threadedParts > 0
      ? `<Override PartName="/xl/persons/person.xml" ContentType="${CT_PERSONS}"/>`
      : "");
  return (
    XML_DECL +
    `<Types xmlns="${NS_CONTENT_TYPES}">` +
    `<Default Extension="rels" ContentType="${CT_RELS}"/>` +
    `<Default Extension="xml" ContentType="application/xml"/>` +
    (commentParts > 0 ? `<Default Extension="vml" ContentType="${CT_VML_DRAWING}"/>` : "") +
    `<Override PartName="/xl/workbook.xml" ContentType="${CT_WORKBOOK}"/>` +
    overrides +
    `<Override PartName="/xl/sharedStrings.xml" ContentType="${CT_SHARED_STRINGS}"/>` +
    PROPS_CONTENT_TYPES +
    `</Types>`
  );
};

const rootRelsXml = (): string =>
  XML_DECL +
  `<Relationships xmlns="${NS_PKG_REL}">` +
  `<Relationship Id="rId1" Type="${REL_OFFICE_DOCUMENT}" Target="xl/workbook.xml"/>` +
  propsRelationships("rId2", "rId3") +
  `</Relationships>`;

/** A workbook's sheet as `<sheets>` lists it: its (sanitized) name and, when hidden, how. */
interface SheetEntry {
  readonly name: string;
  readonly visibility: Option.Option<SheetVisibility>;
}

/**
 * `<bookViews>` opening the workbook on its first shown sheet when the first
 * sheet is hidden (Excel opens on `activeTab`, 0 by default, and a hidden
 * active sheet is shown anyway); nothing otherwise.
 */
const bookViewsXml = (sheets: ReadonlyArray<SheetEntry>): string => {
  const active = sheets.findIndex((s) => Option.isNone(s.visibility));
  return active <= 0 ? "" : `<bookViews><workbookView activeTab="${active}"/></bookViews>`;
};

const workbookXml = (entries: ReadonlyArray<SheetEntry>, recalculate: boolean): string => {
  const sheets = entries
    .map(
      ({ name, visibility }, i) =>
        `<sheet name="${escapeAttr(name)}" sheetId="${i + 1}"${Option.match(visibility, {
          onNone: () => "",
          onSome: (state) => ` state="${state}"`,
        })} r:id="rId${i + 1}"/>`,
    )
    .join("");
  return (
    XML_DECL +
    `<workbook xmlns="${NS_MAIN}" xmlns:r="${NS_REL_DOC}">` +
    bookViewsXml(entries) +
    `<sheets>${sheets}</sheets>` +
    // Formulas without a cached result would show blank until recalculated.
    (recalculate ? `<calcPr fullCalcOnLoad="1"/>` : "") +
    `</workbook>`
  );
};

const workbookRelsXml = (sheetCount: number, persons: boolean): string => {
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
    (persons
      ? `<Relationship Id="rId${sheetCount + 2}" Type="${REL_PERSONS}" Target="persons/person.xml"/>`
      : "") +
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

/** A relationship of a worksheet part: its id, type, target and whether the target is outside the package. */
interface SheetRel {
  readonly id: string;
  readonly type: string;
  readonly target: string;
  readonly external: boolean;
}

/** A worksheet's part, and the relationships it needs: its hyperlinks' (#67) and its comments'. */
interface SheetPart {
  readonly xml: string;
  readonly rels: ReadonlyArray<SheetRel>;
}

/** A worksheet part's `_rels` part. */
const sheetRelsXml = (rels: SheetPart["rels"]): string =>
  XML_DECL +
  `<Relationships xmlns="${NS_PKG_REL}">` +
  rels
    .map(
      ({ id, type, target, external }) =>
        `<Relationship Id="${id}" Type="${type}" Target="${escapeAttr(target)}"${external ? ' TargetMode="External"' : ""}/>`,
    )
    .join("") +
  `</Relationships>`;

/**
 * The relationships of a worksheet's comments, numbered after its `taken`
 * hyperlink relationships: the comments part, the VML drawing (#67), the
 * drawing's id being the one `<legacyDrawing>` names, and, for a sheet with
 * threads (`threadedPart`, from 1; 0 for none), its threaded comments.
 */
const commentRels = (part: number, taken: number, threadedPart: number) => ({
  rels: [
    {
      id: `rId${taken + 1}`,
      type: REL_COMMENTS,
      target: `../comments${part}.xml`,
      external: false,
    },
    {
      id: `rId${taken + 2}`,
      type: REL_VML_DRAWING,
      target: `../drawings/vmlDrawing${part}.vml`,
      external: false,
    },
    ...(threadedPart > 0
      ? [
          {
            id: `rId${taken + 3}`,
            type: REL_THREADED_COMMENTS,
            target: `../threadedComments/threadedComment${threadedPart}.xml`,
            external: false,
          },
        ]
      : []),
  ],
  drawingId: `rId${taken + 2}`,
});

/**
 * A worksheet's part. A `NaN` or `±Infinity` number, which SpreadsheetML
 * cannot hold, is written as `#NUM!` and reported in `notes` (#112). A rich
 * cell that breaks the `Xlsx` profile's `whole` rule (a link over only part of
 * it, which a document built through `trustAs` can hold) is listed in
 * `partial` (as `Sheet!A1`), for the writer to refuse rather than widen it
 * silently (#67). A sheet whose comments are written as part `commentPart`
 * (from 1; 0 for none) points its `<legacyDrawing>` at their drawing.
 */
const worksheetXml = (
  ws: Worksheet,
  sharedStrings: SharedStrings,
  merges: string,
  notes: Array<Diagnostic>,
  partial: Array<string>,
  commentPart: number,
  threadedPart: number,
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
          if (
            Predicate.isTagged(cell, "CellRichText") &&
            Xlsx.whole.some((rule) => breaksWhole(cell.runs, rule))
          )
            partial.push(`${ws.name}!${link.value.ref}`);
        }
        const typeAttr = rendered.type === null ? "" : ` t="${rendered.type}"`;
        return [`<c r="${toA1(col, index)}"${typeAttr}>${rendered.inner}</c>`];
      });
      const height = isPlainRow(row) ? undefined : row.height;
      const ht = height === undefined ? "" : ` ht="${height}" customHeight="1"`;
      const hidden = !isPlainRow(row) && row.hidden === true ? ' hidden="1"' : "";
      return `<row r="${index + 1}"${ht}${hidden}>${cells.join("")}</row>`;
    })
    .join("");
  const hyperlinks = hyperlinksXml(links, escapeAttr);
  const linkRels: ReadonlyArray<SheetRel> = hyperlinks.rels.map(({ id, url }) => ({
    id,
    type: REL_HYPERLINK,
    target: url,
    external: true,
  }));
  const commented =
    commentPart > 0
      ? Option.some(commentRels(commentPart, linkRels.length, threadedPart))
      : Option.none();
  const ns = hyperlinks.xml === "" && Option.isNone(commented) ? "" : ` xmlns:r="${NS_REL_DOC}"`;
  // <legacyDrawing> follows <hyperlinks> in a worksheet's element order
  const legacyDrawing = Option.match(commented, {
    onNone: () => "",
    onSome: ({ drawingId }) => `<legacyDrawing r:id="${drawingId}"/>`,
  });
  return {
    xml:
      XML_DECL +
      `<worksheet xmlns="${NS_MAIN}"${ns}>${dimension}${colsXml(ws.columns)}<sheetData>${rows}</sheetData>${merges}${hyperlinks.xml}${legacyDrawing}</worksheet>`,
    rels: [...linkRels, ...Option.match(commented, { onNone: () => [], onSome: (c) => c.rels })],
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
    if (worksheets.every((ws) => ws.visibility !== undefined))
      return Effect.fail(
        new WriteError({
          format: "xlsx",
          reason: "every worksheet is hidden: a workbook must show at least one",
        }),
      );
    const merges = Result.all(worksheets.map((ws) => mergeCellsXml(ws.merges)));
    if (Result.isFailure(merges))
      return Effect.fail(new WriteError({ format: "xlsx", reason: merges.failure }));
    // each sheet with comments, numbered from 1 as Excel numbers their parts
    const withComments = worksheets.map((ws) => Arr.isReadonlyArrayNonEmpty(ws.comments ?? []));
    const commentPart = withComments.map((has, i) =>
      has ? withComments.slice(0, i + 1).filter(Boolean).length : 0,
    );
    // each sheet with a thread has a threaded comments part too, numbered likewise,
    // and the workbook lists the people who write them
    const withThreads = worksheets.map((ws) =>
      (ws.comments ?? []).some((c) => isThreadComment(c.comment)),
    );
    const threadedPart = withThreads.map((has, i) =>
      has ? withThreads.slice(0, i + 1).filter(Boolean).length : 0,
    );
    const people = commentPeople(worksheets.map((ws) => ws.comments ?? []));
    const comments = Result.all(
      worksheets.map((ws, i): Result.Result<Option.Option<CommentsXml>, string> =>
        commentPart[i] === 0
          ? Result.succeed(Option.none())
          : Result.mapBoth(commentsXml(ws.comments ?? [], commentPart[i] ?? 0, i + 1, people), {
              onSuccess: Option.some,
              onFailure: (reason) => `worksheet "${ws.name}": ${reason}`,
            }),
      ),
    );
    if (Result.isFailure(comments))
      return Effect.fail(new WriteError({ format: "xlsx", reason: comments.failure }));
    return Effect.try({
      try: () => {
        const sharedStrings = new SharedStrings();
        const names = worksheets.map((w) => w.name);
        const sheetNames = sanitizeSheetNames(names);
        const notes = renamedSheets(names, sheetNames);
        comments.success.forEach((part, i) => {
          if (Option.isSome(part) && Arr.isReadonlyArrayNonEmpty(part.value.unkept))
            notes.push(unkeptDiagnostic(names[i] ?? "", part.value.unkept));
          if (Option.isSome(part) && Arr.isReadonlyArrayNonEmpty(part.value.reshaped))
            notes.push(reshapedDiagnostic(names[i] ?? "", part.value.reshaped));
        });
        const partial: Array<string> = [];
        const sheetXmls = worksheets.map((ws, i) =>
          worksheetXml(
            ws,
            sharedStrings,
            merges.success[i] ?? "",
            notes,
            partial,
            commentPart[i] ?? 0,
            threadedPart[i] ?? 0,
          ),
        );

        const recalculate = worksheets.some((ws) =>
          ws.rows.some((row) =>
            rowCellsOf(row).some(
              (cell) => Predicate.isTagged(cell, "CellFormula") && cell.result === undefined,
            ),
          ),
        );

        const files = {
          "[Content_Types].xml": contentTypesXml(
            worksheets.length,
            commentPart.reduce((n, part) => Math.max(n, part), 0),
            threadedPart.reduce((n, part) => Math.max(n, part), 0),
          ),
          "_rels/.rels": rootRelsXml(),
          ...propsParts(doc.meta),
          "xl/workbook.xml": workbookXml(
            sheetNames.map((name, i) => ({
              name,
              visibility: Option.fromUndefinedOr(worksheets[i]?.visibility),
            })),
            recalculate,
          ),
          "xl/_rels/workbook.xml.rels": workbookRelsXml(
            worksheets.length,
            withThreads.some(Boolean),
          ),
          "xl/sharedStrings.xml": sharedStringsXml(sharedStrings),
          ...Object.fromEntries([
            ...comments.success.flatMap((part, i) =>
              Option.match(part, {
                onNone: () => [],
                onSome: ({ comments: xml, vml, threaded }) => [
                  [`xl/comments${commentPart[i]}.xml`, XML_DECL + xml] as const,
                  [`xl/drawings/vmlDrawing${commentPart[i]}.vml`, vml] as const,
                  ...Arr.fromOption(threaded).map(
                    (t) =>
                      [
                        `xl/threadedComments/threadedComment${threadedPart[i]}.xml`,
                        XML_DECL + t,
                      ] as const,
                  ),
                ],
              }),
            ),
            ...(withThreads.some(Boolean)
              ? [["xl/persons/person.xml", XML_DECL + personsXml(people)] as const]
              : []),
            ...sheetXmls.flatMap((part, i) => {
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
          ]),
        };

        return [
          bytes(zipParts(files, level)),
          [...notes, ...metadataDiagnostics("xlsx", doc.meta)],
          partial,
        ] as const;
      },
      catch: (cause) =>
        new WriteError({
          format: "xlsx",
          reason: `Failed to generate xlsx package: ${String(cause)}`,
          cause,
        }),
    }).pipe(
      Effect.flatMap(([content, notes, partial]) =>
        Arr.isReadonlyArrayNonEmpty(partial)
          ? Effect.fail(
              new WriteError({
                format: "xlsx",
                reason: `${partial.join(", ")} link only part of their text, which SpreadsheetML can't hold: narrow the document to the Xlsx profile first, which widens each link over its cell`,
              }),
            )
          : Effect.as(logDiagnostics(notes), content),
      ),
    );
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
