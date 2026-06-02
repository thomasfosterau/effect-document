/**
 * Bridging between the two layers of the intermediate representation:
 * the tabular Workbook model and the Pandoc-style Document AST.
 *
 * Workbook -> Document is faithful (every cell becomes a table cell).
 * Document -> Workbook is lossy: only Table blocks survive, and rich inline
 * formatting is collapsed to plain text.
 */

import { Array as Arr, Effect } from "effect";
import {
  Document,
  Heading,
  Str,
  Table,
  TableCell,
  TableRow,
  blocksToText,
  inlinesToText,
  plainText,
  type Block,
} from "../document.js";
import { Sheet, Workbook, cell, cellToString, type Cell } from "../tabular.js";
import { ConversionError } from "../errors.js";

// ============================================================================
// Workbook -> Document
// ============================================================================

export interface WorkbookToDocumentOptions {
  /**
   * Emit a level-1 Heading with the sheet name before each table.
   * Defaults to true when the workbook has more than one sheet.
   */
  readonly includeSheetHeadings?: boolean;
}

const cellToBlocks = (c: Cell): ReadonlyArray<Block> =>
  c._tag === "CellNull" ? [] : [plainText(cellToString(c))];

const sheetToTable = (sheet: Sheet): Table => {
  const head =
    sheet.headers === null
      ? []
      : [
          new TableRow({
            cells: sheet.headers.map(
              (header) => new TableCell({ content: [plainText(header)] })
            ),
          }),
        ];

  const body = sheet.rows.map(
    (row) =>
      new TableRow({
        cells: row.map((c) => new TableCell({ content: cellToBlocks(c) })),
      })
  );

  return new Table({ caption: sheet.name, head, body });
};

/**
 * Convert a Workbook into a Document of Table blocks (one per sheet).
 */
export const workbookToDocument = (
  workbook: Workbook,
  options?: WorkbookToDocumentOptions
): Effect.Effect<Document, ConversionError> =>
  Effect.sync(() => {
    const includeHeadings =
      options?.includeSheetHeadings ?? workbook.sheets.length > 1;

    const blocks: Block[] = [];
    for (const sheet of workbook.sheets) {
      if (includeHeadings) {
        blocks.push(
          new Heading({ level: 1, content: [new Str({ text: sheet.name })] })
        );
      }
      blocks.push(sheetToTable(sheet));
    }

    return new Document({ meta: {}, blocks });
  });

// ============================================================================
// Document -> Workbook
// ============================================================================

export interface DocumentToWorkbookOptions {
  /**
   * What to do with blocks that are not tables (or headings naming tables):
   * - "ignore" (default): drop them
   * - "fail": fail with a ConversionError
   */
  readonly onNonTable?: "ignore" | "fail";
}

const tableToSheet = (table: Table, fallbackName: string): Sheet => {
  const firstHeadRow = table.head[0];
  const headers =
    firstHeadRow === undefined
      ? null
      : firstHeadRow.cells.map((c) => blocksToText(c.content));

  const rows = table.body.map((row) =>
    row.cells.map((c) => cell.str(blocksToText(c.content)))
  );

  return new Sheet({
    name: table.caption ?? fallbackName,
    headers,
    rows,
  });
};

/**
 * Convert a Document into a Workbook by extracting its Table blocks
 * (one sheet per table). A Heading immediately preceding a table names the
 * sheet when the table has no caption.
 */
export const documentToWorkbook = (
  document: Document,
  options?: DocumentToWorkbookOptions
): Effect.Effect<Workbook, ConversionError> =>
  Effect.gen(function* () {
    const sheets: Sheet[] = [];
    let pendingName: string | null = null;

    for (const block of document.blocks) {
      if (block._tag === "Heading") {
        pendingName = inlinesToText(block.content);
        continue;
      }

      if (block._tag === "Table") {
        const fallbackName = pendingName ?? `Sheet${sheets.length + 1}`;
        sheets.push(tableToSheet(block, fallbackName));
        pendingName = null;
        continue;
      }

      if (options?.onNonTable === "fail") {
        return yield* new ConversionError({
          reason: `Document contains a non-table block ("${block._tag}") that cannot be represented in a workbook`,
        });
      }
      // otherwise: ignore the block
      pendingName = null;
    }

    if (!Arr.isNonEmptyArray(sheets)) {
      return yield* new ConversionError({
        reason: "Document contains no tables to convert into a workbook",
      });
    }

    return new Workbook({ sheets });
  });
