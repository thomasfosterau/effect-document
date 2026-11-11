/**
 * The tabular regions of a document (#188): every worksheet and every prose
 * table, wherever it sits, each with a stable locator, its name or caption,
 * its size and a header guess, and prose tables flattened to a text grid,
 * so an import step can list them and let a user pick one.
 */

import * as Arr from "effect/Array";
import * as Predicate from "effect/Predicate";
import type { Block, Shape, Table, TableRow, Worksheet } from "./ast.ts";
import type { Document } from "./document.ts";
import { blocksToText, inlinesToText } from "./document.ts";
import { cellOf, rowCellsOf, sheetExtent } from "./sheet.ts";

/**
 * Where a region is in its document, as a loss entry's path is (#112):
 * block indexes from the top, then list-item, slide, shape and table-cell
 * indexes, and parts such as `"caption"` or `"body"`. Stable for an unchanged
 * document, so a caller can keep it and find the region again.
 */
export type TableLocator = ReadonlyArray<number | string>;

/** A merged cell of a prose table: its top-left position and how far it spans. */
export interface CellSpan {
  readonly row: number;
  readonly column: number;
  readonly rowSpan: number;
  readonly colSpan: number;
}

/** A worksheet, as a candidate table. */
export interface WorksheetRegion {
  readonly _tag: "WorksheetRegion";
  readonly locator: TableLocator;
  /** The sheet's name. */
  readonly name: string;
  /** One past the last row index, and one past the rightmost column (`sheetExtent`). */
  readonly rows: number;
  readonly columns: number;
  /**
   * Whether the first row looks like a header: every cell in it is text, and
   * some column below it holds a number, boolean or date (the CSV reader's
   * rule, #88). A heuristic for a UI's default, which the user may override.
   */
  readonly headerRow: boolean;
  /** The worksheet itself, for reading its cells. */
  readonly worksheet: Worksheet;
}

/** A prose table (or a slide's table shape), as a candidate table. */
export interface ProseTableRegion {
  readonly _tag: "ProseTableRegion";
  readonly locator: TableLocator;
  /** The caption's text, if it has one. */
  readonly caption: string | undefined;
  readonly rows: number;
  readonly columns: number;
  /** How many of the first rows are the table's head (`Table.head`), the header a table declares. */
  readonly headerRows: number;
  /**
   * Every row's cells as text, `rows` by `columns`: a merged cell's text sits
   * at its top-left position and the positions it covers are empty strings.
   */
  readonly cells: ReadonlyArray<ReadonlyArray<string>>;
  /** The merged cells, so a caller can tell a covered position from an empty cell. */
  readonly spans: ReadonlyArray<CellSpan>;
  /** The table itself. */
  readonly table: Table;
}

/** One tabular region of a document: a worksheet or a prose table. */
export type TableRegion = WorksheetRegion | ProseTableRegion;

/** A cell's span along one axis: a positive whole number, 1 when absent or invalid. */
const spanOf = (n: number | undefined): number =>
  n !== undefined && Number.isInteger(n) && n > 1 ? n : 1;

/** A prose table's rows on a grid: its text by position, its merged cells and its width. */
interface Layout {
  readonly cells: ReadonlyArray<ReadonlyArray<string>>;
  readonly spans: ReadonlyArray<CellSpan>;
  readonly columns: number;
}

/** The rows of a prose table laid out on a grid, merged cells placed and the covered positions left empty. */
const layOut = (rows: ReadonlyArray<TableRow>): Layout => {
  const grid: Array<Array<string | undefined>> = rows.map(() => []);
  const spans: Array<CellSpan> = [];
  rows.forEach((row, r) => {
    const line = grid[r] ?? [];
    let column = 0;
    row.cells.forEach((cell) => {
      // the next position no merged cell from an earlier row covers
      while (line[column] !== undefined) column += 1;
      const rowSpan = Math.min(spanOf(cell.rowSpan), rows.length - r);
      const colSpan = spanOf(cell.colSpan);
      const at = column;
      grid.slice(r, r + rowSpan).forEach((covered, dr) =>
        Arr.makeBy(colSpan, (dc) => dc).forEach((dc) => {
          covered[at + dc] = dr === 0 && dc === 0 ? blocksToText(cell.content) : "";
        }),
      );
      if (rowSpan > 1 || colSpan > 1) spans.push({ row: r, column: at, rowSpan, colSpan });
      column += colSpan;
    });
  });
  const columns = grid.reduce((m, row) => Math.max(m, row.length), 0);
  return {
    cells: grid.map((row) => Arr.makeBy(columns, (c) => row[c] ?? "")),
    spans,
    columns,
  };
};

/** A prose table as a region. */
const tableRegion = (table: Table, locator: TableLocator): ProseTableRegion => {
  const rows = [...table.head, ...table.body, ...table.foot];
  const { cells, spans, columns } = layOut(rows);
  return {
    _tag: "ProseTableRegion",
    locator,
    caption: table.caption === undefined ? undefined : inlinesToText(table.caption),
    rows: rows.length,
    columns: Math.max(columns, table.colSpecs.length),
    headerRows: table.head.length,
    cells,
    spans,
    table,
  };
};

/** The #88 header rule over a worksheet's first two rows' worth of cells. */
const hasHeaderRow = (ws: Worksheet): boolean => {
  const [first, ...rest] = ws.rows;
  if (first === undefined || Arr.isReadonlyArrayEmpty(rest)) return false;
  const head = rowCellsOf(first).map(cellOf);
  if (head.some((c) => c === undefined || !Predicate.isTagged(c, "CellText"))) return false;
  return rest.some((row) =>
    rowCellsOf(row).some((position) => {
      const c = cellOf(position);
      return (
        c !== undefined &&
        (Predicate.isTagged(c, "CellNumber") ||
          Predicate.isTagged(c, "CellBoolean") ||
          Predicate.isTagged(c, "CellDate"))
      );
    }),
  );
};

/** A worksheet as a region. */
const worksheetRegion = (ws: Worksheet, locator: TableLocator): WorksheetRegion => {
  const { rows, columns } = sheetExtent(ws);
  return {
    _tag: "WorksheetRegion",
    locator,
    name: ws.name,
    rows,
    columns,
    headerRow: hasHeaderRow(ws),
    worksheet: ws,
  };
};

type Work =
  | { readonly k: "blocks"; readonly blocks: ReadonlyArray<Block>; readonly at: TableLocator }
  | { readonly k: "shapes"; readonly shapes: ReadonlyArray<Shape>; readonly at: TableLocator };

/** The child block lists of a block that holds blocks, with the segments that locate them. */
const childBlocks = (
  b: Block,
): ReadonlyArray<readonly [ReadonlyArray<number | string>, ReadonlyArray<Block>]> => {
  if (Predicate.isTagged(b, "BlockQuote") || Predicate.isTagged(b, "Div")) return [[[], b.content]];
  if (Predicate.isTagged(b, "Figure"))
    return [
      [["caption"], b.caption],
      [[], b.content],
    ];
  if (Predicate.isTagged(b, "BulletList") || Predicate.isTagged(b, "OrderedList"))
    return b.items.map((item, i) => [[i], item]);
  if (Predicate.isTagged(b, "DefinitionList"))
    return b.items.flatMap((item, i) => item.definitions.map((d, j) => [[i, j], d] as const));
  return [];
};

/**
 * Every tabular region of `doc`, in document order (#188): each `Worksheet`,
 * each prose `Table` (inside quotes, `Div`s, `Figure`s, list items and other
 * tables' cells too) and each slide's table shape. The walk keeps its own
 * stack, so a deeply nested document can't overflow the call stack.
 *
 * ```ts
 * const regions = candidateTables(doc);
 * regions.map((r) => (r._tag === "WorksheetRegion" ? r.name : r.caption));
 * ```
 */
export const candidateTables = (doc: Document): ReadonlyArray<TableRegion> => {
  const out: Array<TableRegion> = [];
  /** Record a prose table at `here`, and queue its cells' blocks, which may hold more tables. */
  const visitTable = (table: Table, here: TableLocator, next: Array<Work>): void => {
    out.push(tableRegion(table, here));
    const sections = [
      ["head", table.head],
      ["body", table.body],
      ["foot", table.foot],
    ] as const;
    sections.forEach(([part, rows]) =>
      rows.forEach((row, r) =>
        row.cells.forEach((cell, c) =>
          next.push({ k: "blocks", blocks: cell.content, at: [...here, part, r, c] }),
        ),
      ),
    );
  };
  // a stack popped from the end, so children are pushed in reverse to keep document order
  const stack: Array<Work> = [{ k: "blocks", blocks: doc.blocks, at: [] }];
  for (let work = stack.pop(); work !== undefined; work = stack.pop()) {
    const next: Array<Work> = [];
    if (work.k === "shapes") {
      const { at } = work;
      work.shapes.forEach((shape, k) => {
        if (Predicate.isTagged(shape, "TableShape")) visitTable(shape.table, [...at, k], next);
        else if (Predicate.isTagged(shape, "TextBox") || Predicate.isTagged(shape, "Placeholder"))
          next.push({ k: "blocks", blocks: shape.content, at: [...at, k] });
      });
    } else {
      const { at } = work;
      work.blocks.forEach((b, i) => {
        const here = [...at, i];
        if (Predicate.isTagged(b, "Worksheet")) out.push(worksheetRegion(b, here));
        else if (Predicate.isTagged(b, "Table")) visitTable(b, here, next);
        else if (Predicate.isTagged(b, "SlideShow"))
          b.slides.forEach((slide, s) =>
            next.push({ k: "shapes", shapes: slide.shapes, at: [...here, s] }),
          );
        else
          childBlocks(b).forEach(([segments, content]) =>
            next.push({ k: "blocks", blocks: content, at: [...here, ...segments] }),
          );
      });
    }
    // regions found deeper come after the ones found here: depth first, in document order
    stack.push(...Arr.reverse(next));
  }
  return out;
};
