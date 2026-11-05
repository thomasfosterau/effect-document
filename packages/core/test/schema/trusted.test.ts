import { describe, expect, test } from "vite-plus/test";
import * as Equal from "effect/Equal";
import * as Schema from "effect/Schema";
import {
  CellBlank,
  CellBoolean,
  CellNumber,
  CellText,
  type SheetCell,
  SheetRow,
  Str,
  Worksheet,
  cell,
  sheetRow,
  sheetRowOf,
  sheetRowFrom,
  sparseRow,
  str,
  worksheet,
  worksheetFromRows,
} from "../../src/schema/index.ts";

/** The nodes the constructors without the schema pass (`schema/trusted.ts`) build. */
type Node = SheetCell | Str | SheetRow | Worksheet;

/**
 * What must match between a node built without the schema pass and one built
 * with `new`: its prototype, its own keys in order, and `Equal.equals`.
 */
const shape = (trusted: Node, built: Node) => ({
  prototype: Object.getPrototypeOf(trusted) === Object.getPrototypeOf(built),
  keys: Reflect.ownKeys(trusted).join() === Reflect.ownKeys(built).join(),
  equal: Equal.equals(trusted, built),
});

const SAME = { prototype: true, keys: true, equal: true };

/** What a schema pass that rejects its input throws. */
const INVALID = "Schema validation failed";

/** A cell from a string: text in column 0, a number after. */
const toCell = (v: string, col: number) => (col === 0 ? cell.text(v) : cell.number(Number(v)));

describe("constructors without the schema pass", () => {
  test("cells and text runs are the nodes `new` builds", () => {
    const pairs: ReadonlyArray<readonly [Node, Node]> = [
      [cell.text("a"), new CellText({ value: "a" })],
      [cell.number(-0), new CellNumber({ value: -0 })],
      [cell.number(Number.NaN), new CellNumber({ value: Number.NaN })],
      [cell.boolean(false), new CellBoolean({ value: false })],
      [cell.blank(), new CellBlank()],
      [str("x"), new Str({ text: "x" })],
    ];
    expect(pairs.map(([trusted, built]) => shape(trusted, built))).toEqual(pairs.map(() => SAME));
    expect(pairs.map(([trusted]) => trusted)).toStrictEqual(pairs.map(([, built]) => built));
  });

  test("sheetRow is `new SheetRow` of its cells, gaps and height key included", () => {
    const cells: Array<SheetCell | undefined> = [cell.text("a"), undefined, cell.number(2)];
    const built = new SheetRow({ index: 3, cells, height: undefined });
    const trusted = sheetRow(3, cells);
    expect(shape(trusted, built)).toEqual(SAME);
    expect(trusted).toStrictEqual(built);
    // the array is copied: the caller's stays its own
    expect(trusted.cells).not.toBe(cells);
    expect(() => sheetRow(3, [cell.text("a"), undefined])).toThrow(INVALID);
  });

  test("sheetRowOf is `new SheetRow`, keeping the array it is given", () => {
    const cells = [cell.text("a"), undefined, cell.number(1)];
    const built = new SheetRow({ index: 4, cells, height: undefined });
    expect(shape(sheetRowOf(4, cells), built)).toEqual(SAME);
    expect(sheetRowOf(4, cells)).toStrictEqual(built);
    expect(sheetRowOf(4, cells).cells).toBe(cells);
    expect(() => sheetRowOf(-1, cells)).toThrow(INVALID);
  });

  test("sheetRowFrom is sheetRow of the mapped cells", () => {
    const values = ["a", "2"];
    const built = sheetRow(1, values.map(toCell));
    expect(shape(sheetRowFrom(1, values, toCell), built)).toEqual(SAME);
    expect(sheetRowFrom(1, values, toCell)).toStrictEqual(built);
    expect(() => sheetRowFrom(-1, values, toCell)).toThrow(INVALID);
  });

  test("sparseRow is `new SheetRow`, with no height key unless one is given", () => {
    const entries: Array<readonly [number, SheetCell]> = [
      [0, cell.text("a")],
      [4, cell.number(5)],
    ];
    const cells = [cell.text("a"), undefined, undefined, undefined, cell.number(5)];
    expect(shape(sparseRow(0, entries), new SheetRow({ index: 0, cells }))).toEqual(SAME);
    expect(shape(sparseRow(0, entries, 12), new SheetRow({ index: 0, cells, height: 12 }))).toEqual(
      SAME,
    );
    expect(Object.hasOwn(sparseRow(0, entries), "height")).toBe(false);
  });

  test("sparseRow fails on out-of-order columns or a bad position, with a SchemaError", () => {
    const a = cell.text("a");
    expect(() =>
      sparseRow(0, [
        [2, a],
        [1, a],
      ]),
    ).toThrow(Schema.SchemaError);
    expect(() =>
      sparseRow(0, [
        [1, a],
        [1, a],
      ]),
    ).toThrow(Schema.SchemaError);
    expect(() => sparseRow(-1, [])).toThrow(INVALID);
    expect(() => sparseRow(0, [[0.5, a]])).toThrow(Schema.SchemaError);
  });

  test("worksheetFromRows is `new Worksheet` of the rows, and checks their order as it does", () => {
    const rows = [sheetRow(0, [cell.text("a")]), sheetRow(3, [cell.number(1)])];
    const built = new Worksheet({ name: "S", columns: [], rows, merges: [] });
    expect(shape(worksheetFromRows("S", rows), built)).toEqual(SAME);
    expect(worksheetFromRows("S", rows)).toStrictEqual(built);
    expect(() => worksheetFromRows("S", [sheetRow(1, []), sheetRow(1, [])])).toThrow(INVALID);
    expect(() => worksheetFromRows("S", [sheetRow(2, []), sheetRow(1, [])])).toThrow(INVALID);
  });

  test("worksheet is `new Worksheet` of its rows", () => {
    const grid = [[cell.text("a")], [cell.number(1)]];
    const built = new Worksheet({
      name: "S",
      columns: [],
      rows: grid.map((cells, index) => sheetRow(index, cells)),
      merges: [],
    });
    expect(shape(worksheet("S", grid), built)).toEqual(SAME);
    expect(worksheet("S", grid)).toStrictEqual(built);
  });
});
