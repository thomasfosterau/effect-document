import { describe, expect, test } from "vite-plus/test";
import * as Equal from "effect/Equal";
import {
  CellBlank,
  CellBoolean,
  CellNumber,
  CellText,
  IndexedCell,
  type SheetCell,
  SheetRow,
  Str,
  Worksheet,
  cell,
  sheetRow,
  sparseRow,
  str,
  worksheet,
} from "../../src/schema/index.ts";

/** The nodes the constructors without the schema pass (`schema/trusted.ts`) build. */
type Node = SheetCell | Str | IndexedCell | SheetRow | Worksheet;

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

  test("sheetRow is `new SheetRow` of its indexed cells, height key included", () => {
    const cells: Array<SheetCell> = [cell.text("a"), cell.number(2)];
    const built = new SheetRow({
      index: 3,
      cells: cells.map((c, col) => new IndexedCell({ col, cell: c })),
      height: undefined,
    });
    const trusted = sheetRow(3, cells);
    expect(shape(trusted, built)).toEqual(SAME);
    expect(trusted).toStrictEqual(built);
    expect(trusted.cells[1]).toStrictEqual(built.cells[1]);
  });

  test("sparseRow is `new SheetRow`, with no height key unless one is given", () => {
    const entries: Array<readonly [number, SheetCell]> = [
      [0, cell.text("a")],
      [4, cell.number(5)],
    ];
    const cells = entries.map(([col, c]) => new IndexedCell({ col, cell: c }));
    expect(shape(sparseRow(0, entries), new SheetRow({ index: 0, cells }))).toEqual(SAME);
    expect(shape(sparseRow(0, entries, 12), new SheetRow({ index: 0, cells, height: 12 }))).toEqual(
      SAME,
    );
    expect(Object.hasOwn(sparseRow(0, entries), "height")).toBe(false);
  });

  test("sparseRow fails on out-of-order columns or a bad position, as `new SheetRow` does", () => {
    const a = cell.text("a");
    expect(() =>
      sparseRow(0, [
        [2, a],
        [1, a],
      ]),
    ).toThrow(INVALID);
    expect(() =>
      sparseRow(0, [
        [1, a],
        [1, a],
      ]),
    ).toThrow(INVALID);
    expect(() => sparseRow(-1, [])).toThrow(INVALID);
    expect(() => sparseRow(0, [[0.5, a]])).toThrow(INVALID);
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
