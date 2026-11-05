import { assert, describe, expect, test } from "vite-plus/test";
import * as Predicate from "effect/Predicate";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import {
  Document,
  SheetRow,
  Worksheet,
  blocksToText,
  cell,
  cellAt,
  cellOf,
  DEFAULT_MAX_DENSE_CELLS,
  DenseGridTooLarge,
  denseRows,
  denseSize,
  document,
  decodeDocumentResult,
  encodeDocumentResult,
  isPlainRow,
  rowCellsOf,
  rowEntries,
  rowIndexes,
  rowsOf,
  sheetExtent,
  sheetRow,
  sparseRow,
  worksheetFromRows,
} from "../../src/schema/index.ts";
import { Profiles, narrow } from "../../src/profile/index.ts";

/** Two values far apart: A1 and C4 (row 3, column 2), nothing between them. */
const sparse = new Worksheet({
  name: "S",
  columns: [],
  rows: [
    new SheetRow({ index: 0, cells: [cell.text("a")] }),
    new SheetRow({ index: 3, cells: [undefined, undefined, cell.number(7)] }),
  ],
  merges: [],
});

const grid = (ws: Worksheet, options?: Parameters<typeof denseRows>[1]) => {
  const rows = denseRows(ws, options);
  assert(Result.isSuccess(rows), "the grid fits its budget");
  return rows.success;
};

const sheetJson = (rows: unknown) => ({
  meta: {},
  blocks: [{ _tag: "Worksheet", name: "S", columns: [], merges: [], rows }],
});

describe("sparse worksheet (#185)", () => {
  test("holds only the cells it has", () => {
    // the rows it has; within a row, a gap is a position (positional cells, #226)
    expect(sparse.rows.flatMap((r) => rowEntries(r))).toHaveLength(2);
    expect(sheetExtent(sparse)).toEqual({ rows: 4, columns: 3 });
    expect(sheetExtent(new Worksheet({ name: "E", columns: [], rows: [], merges: [] }))).toEqual({
      rows: 0,
      columns: 0,
    });
  });

  /** One cell at XFD1048576: an extent of 17 billion cells, holding one. */
  const far = new Worksheet({
    name: "Far",
    columns: [],
    rows: [sparseRow(1_048_575, [[16_383, cell.text("z")]])],
    merges: [],
  });

  test("a far-out cell costs its row's width, not the sheet's extent", () => {
    expect(sheetExtent(far)).toEqual({ rows: 1_048_576, columns: 16_384 });
    const wire = Schema.fromJsonString(Document);
    const json = Schema.encodeUnknownSync(wire)(document([far]));
    // the million rows above it cost nothing; its own row is 16,384 positions
    // (XLSX's widest), each gap a `null`
    expect(json.length).toBeLessThan(16_384 * 5 + 500);
    expect(Schema.decodeUnknownSync(wire)(json)).toEqual(document([far]));
  });

  test("denseRows derives the rectangular grid, gaps as blanks", () => {
    const rows = grid(sparse);
    expect(rows).toHaveLength(4);
    expect(rows.every((row) => row.length === 3)).toBe(true);
    expect(rows[0]![0]).toMatchObject({ _tag: "CellText", value: "a" });
    expect(rows[3]![2]).toMatchObject({ _tag: "CellNumber", value: 7 });
    expect(rows[1]!.every(Predicate.isTagged("CellBlank"))).toBe(true);
  });

  test("denseRows without rectangular keeps each row to its last cell", () => {
    expect(grid(sparse, { rectangular: false }).map((r) => r.length)).toEqual([1, 0, 0, 3]);
    expect(denseSize(sparse, { rectangular: false })).toBe(4 + 1 + 3);
    expect(denseSize(sparse)).toBe(4 * 4);
  });

  test("denseRows refuses a grid over its budget before allocating it", () => {
    const result = denseRows(far);
    assert(Result.isFailure(result));
    expect(result.failure).toBeInstanceOf(DenseGridTooLarge);
    expect(result.failure).toMatchObject({ maxCells: DEFAULT_MAX_DENSE_CELLS });
    expect(denseSize(far, { rectangular: false })).toBe(1_048_576 + 16_384);
    expect(Result.isFailure(denseRows(far, { rectangular: false, maxCells: 1_000_000 }))).toBe(
      true,
    );
    // the budget is the caller's to set, and counts one per row too
    expect(Result.isFailure(denseRows(sparse, { maxCells: 15 }))).toBe(true);
    expect(grid(sparse, { maxCells: 16 })).toHaveLength(4);
    const tall = new Worksheet({
      name: "Tall",
      columns: [],
      rows: [new SheetRow({ index: 1e12, cells: [], height: 12 })],
      merges: [],
    });
    expect(Result.isFailure(denseRows(tall))).toBe(true);
  });

  test("sheetRow keeps every cell of a dense row, blanks included", () => {
    const row = sheetRow(2, [cell.text("x"), cell.blank(), cell.number(1)], 18);
    expect(row.index).toBe(2);
    expect(row.height).toBe(18);
    expect(row.cells).toEqual([cell.text("x"), cell.blank(), cell.number(1)]);
  });

  test("a plain cell stands for its unstyled node, and is its bare value in JSON", () => {
    const row = sheetRow(0, ["a", 1.5, true, cell.number(2), undefined, false]);
    expect(rowEntries(row)).toEqual([
      [0, cell.text("a")],
      [1, cell.number(1.5)],
      [2, cell.boolean(true)],
      [3, cell.number(2)],
      [5, cell.boolean(false)],
    ]);
    expect(cellAt(row, 4)).toBeUndefined();
    expect(cellOf("x")).toStrictEqual(cell.text("x"));
    const encoded = Schema.encodeSync(SheetRow)(row);
    expect(encoded.cells).toEqual(["a", 1.5, true, { _tag: "CellNumber", value: 2 }, null, false]);
    expect(Schema.decodeSync(SheetRow)(encoded)).toEqual(row);
    // a plain number is finite: JSON holds no other (a node carries NaN and ±Infinity)
    expect(() => sheetRow(0, [Number.NaN])).toThrow("Schema validation failed");
    expect(cellAt(sheetRow(0, [cell.number(Number.NaN)]), 0)).toStrictEqual(
      cell.number(Number.NaN),
    );
    // a sheet of plain cells narrows and lays out as the same sheet of nodes
    const plain = new Worksheet({ name: "P", columns: [], rows: [row], merges: [] });
    expect(narrow(document([plain]), Profiles.Csv).loss.entries).toEqual([]);
    expect(grid(plain)[0]).toEqual([
      cell.text("a"),
      cell.number(1.5),
      cell.boolean(true),
      cell.number(2),
      cell.blank(),
      cell.boolean(false),
    ]);
  });

  test("a row's cells are positional: a gap is undefined, and the last position holds a cell", () => {
    const row = sheetRow(0, [cell.text("a"), undefined, cell.number(3)]);
    expect(rowEntries(row)).toEqual([
      [0, cell.text("a")],
      [2, cell.number(3)],
    ]);
    expect(
      sparseRow(0, [
        [0, cell.text("a")],
        [2, cell.number(3)],
      ]).cells,
    ).toStrictEqual(row.cells);
    expect(() => sheetRow(0, [cell.text("a"), undefined])).toThrow("Schema validation failed");
    // a gap is `null` in JSON, and decodes back to a gap
    const encoded = Schema.encodeSync(SheetRow)(row);
    expect(encoded.cells[1]).toBeNull();
    expect(Schema.decodeSync(SheetRow)(encoded)).toEqual(row);
  });

  test("text collapse is the cells a sheet holds, not its gaps", () => {
    expect(blocksToText([sparse])).toBe("a\n7");
    expect(blocksToText([far])).toBe("z");
  });

  test("narrowing to prose lays the worksheet out as its dense grid", () => {
    const { document: md } = narrow(document([sparse]), Profiles.Markdown);
    const tableBlock = md.blocks[0];
    assert(Predicate.isTagged(tableBlock, "Table"));
    expect(tableBlock.body).toHaveLength(4);
    expect(tableBlock.body.every((r) => r.cells.length === 3)).toBe(true);
  });

  test("narrowing a sheet too large to lay out drops it and reports the loss", () => {
    const { document: md, loss } = narrow(document([far]), Profiles.Markdown);
    expect(md.blocks).toEqual([]);
    expect(loss.isLossless).toBe(false);
    expect(loss.entries).toContainEqual(
      expect.objectContaining({ feature: "sheet.worksheet", action: "dropped" }),
    );
  });

  const decode = Schema.decodeUnknownResult(Document);
  const text = { _tag: "CellText", value: "v" };

  test("decodes rows in ascending order, a gap between cells written null", () => {
    const r = decode(
      sheetJson([
        { index: 1, cells: [text] },
        { index: 5, cells: [null, null, text, null, text] },
      ]),
    );
    expect(Result.isSuccess(r)).toBe(true);
  });

  test.each([
    [
      "rows out of order",
      [
        { index: 2, cells: [] },
        { index: 1, cells: [] },
      ],
    ],
    [
      "a repeated row",
      [
        { index: 1, cells: [] },
        { index: 1, cells: [] },
      ],
    ],
    ["a negative row", [{ index: -1, cells: [] }]],
    ["a trailing gap", [{ index: 0, cells: [text, null] }]],
    ["an indexed cell (the old form)", [{ index: 0, cells: [{ col: 0, cell: text }] }]],
  ])("rejects %s", (_, rows) => {
    expect(Result.isFailure(decode(sheetJson(rows)))).toBe(true);
  });

  test("the constructor rejects a trailing gap too", () => {
    expect(() => new SheetRow({ index: 0, cells: [cell.text("a"), undefined] })).toThrow(
      "Schema validation failed",
    );
  });
});

describe("plain rows (#227)", () => {
  const decode = Schema.decodeUnknownResult(Document);
  const text = { _tag: "CellText", value: "v" };
  /** Row 0 and 1 plain, row 4 a node with a height, row 5 plain. */
  const mixed = worksheetFromRows("M", [
    ["a", 1],
    [cell.text("b"), undefined, true],
    sheetRow(4, [2.5], 18),
    ["c"],
  ]);

  test("a plain row stands for the row one past the one before it", () => {
    expect(rowIndexes(mixed)).toEqual([0, 1, 4, 5]);
    expect(rowsOf(mixed)).toEqual([
      sheetRow(0, ["a", 1]),
      sheetRow(1, [cell.text("b"), undefined, true]),
      sheetRow(4, [2.5], 18),
      sheetRow(5, ["c"]),
    ]);
    expect(rowsOf(mixed).every((r) => r instanceof SheetRow)).toBe(true);
    expect(mixed.rows.map(isPlainRow)).toEqual([true, true, false, true]);
    expect(rowsOf(mixed).map((r) => r.height)).toEqual([undefined, undefined, 18, undefined]);
    expect(rowCellsOf(mixed.rows[1] ?? [])).toEqual([cell.text("b"), undefined, true]);
  });

  test("the views read plain rows as the rows they stand for", () => {
    const asNodes = new Worksheet({ name: "M", columns: [], rows: rowsOf(mixed), merges: [] });
    expect(sheetExtent(mixed)).toEqual({ rows: 6, columns: 3 });
    expect(sheetExtent(mixed)).toEqual(sheetExtent(asNodes));
    expect(grid(mixed)).toEqual(grid(asNodes));
    expect(denseSize(mixed, { rectangular: false })).toBe(
      denseSize(asNodes, { rectangular: false }),
    );
    expect(blocksToText([mixed])).toBe(blocksToText([asNodes]));
    expect(rowEntries(["a", undefined, 3])).toEqual([
      [0, cell.text("a")],
      [2, cell.number(3)],
    ]);
    expect(cellAt(["a", undefined, 3], 2)).toStrictEqual(cell.number(3));
  });

  test("worksheetFromRows is new Worksheet for plain rows, and fails as it does", () => {
    const rows = [["a", 1], sheetRow(3, ["x"]), [true]];
    expect(worksheetFromRows("S", rows)).toStrictEqual(
      new Worksheet({ name: "S", columns: [], rows, merges: [] }),
    );
    // a node must come after the rows before it, plain ones included
    expect(() => worksheetFromRows("S", [["a"], ["b"], sheetRow(1, ["c"])])).toThrow(
      "Schema validation failed",
    );
    // a plain row holds positional cells, the last a cell
    expect(() => worksheetFromRows("S", [["a", undefined]])).toThrow("Schema validation failed");
    expect(() => worksheetFromRows("S", [[Number.NaN]])).toThrow("Schema validation failed");
  });

  test("the numberRows hint changes nothing but the speed", () => {
    const rows = [[1, 2.5], ["a", 3], [4], sheetRow(7, [1])];
    const plain = worksheetFromRows("S", rows);
    // the right hint, a wrong one, and one past the plain rows
    expect(worksheetFromRows("S", rows, [0, 2])).toStrictEqual(plain);
    expect(worksheetFromRows("S", rows, [1])).toStrictEqual(plain);
    expect(worksheetFromRows("S", rows, [3])).toStrictEqual(plain);
    expect(() => worksheetFromRows("S", [[1, Number.NaN]], [0])).toThrow(
      "Schema validation failed",
    );
  });

  test("a plain row is a bare array in JSON, through Schema and the stack-safe codec", () => {
    const doc = document([mixed]);
    const json = Schema.encodeSync(Document)(doc);
    expect(json.blocks[0]).toMatchObject({
      rows: [
        ["a", 1],
        [{ _tag: "CellText", value: "b" }, null, true],
        { index: 4, cells: [2.5], height: 18 },
        ["c"],
      ],
    });
    expect(Schema.decodeSync(Document)(json)).toEqual(doc);
    const fast = encodeDocumentResult(doc);
    assert(Result.isSuccess(fast));
    expect(fast.success).toEqual(json);
    const back = decodeDocumentResult(json);
    assert(Result.isSuccess(back));
    expect(back.success).toEqual(doc);
    // the codec rejects what Schema rejects
    const bad = {
      meta: {},
      blocks: [{ _tag: "Worksheet", name: "S", columns: [], merges: [], rows: [["a", null]] }],
    };
    expect(Result.isFailure(decode(bad))).toBe(true);
    expect(Result.isFailure(decodeDocumentResult(bad))).toBe(true);
    const unordered = sheetJson([["a"], ["b"], { index: 1, cells: [text] }]);
    expect(Result.isFailure(decode(unordered))).toBe(true);
    expect(Result.isFailure(decodeDocumentResult(unordered))).toBe(true);
  });

  test("narrowing keeps a plain row plain, and reports as for its node", () => {
    const { document: out, loss } = narrow(document([mixed]), Profiles.Csv);
    const asNodes = new Worksheet({ name: "M", columns: [], rows: rowsOf(mixed), merges: [] });
    const fromNodes = narrow(document([asNodes]), Profiles.Csv);
    expect(loss.entries).toEqual(fromNodes.loss.entries);
    const ws = out.blocks[0];
    assert(Predicate.isTagged(ws, "Worksheet"));
    expect(ws.rows.map(isPlainRow)).toEqual([true, true, false, true]);
    const nodes = fromNodes.document.blocks[0];
    assert(Predicate.isTagged(nodes, "Worksheet"));
    expect(rowsOf(ws)).toEqual(rowsOf(nodes));
  });
});
