import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Predicate from "effect/Predicate";
import * as Result from "effect/Result";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { assert, describe, expect, test } from "vite-plus/test";
import {
  bytes,
  cell,
  type Content,
  document,
  MergeRange,
  rowsOf,
  sheetRow,
  SheetColumn,
  trustAs,
  withSheetLayout,
  Worksheet,
  worksheet,
  worksheetFromRows,
} from "@thomasfosterau/effect-document";
import { makeXlsxReader, makeXlsxWriter } from "../../../src/ooxml/xlsx/index.ts";
import { MAX_COLUMNS } from "../../../src/ooxml/xlsx/layout.ts";

const merge = (fromRow: number, fromCol: number, toRow: number, toCol: number) =>
  new MergeRange({ fromRow, fromCol, toRow, toCol });

const SHEET = worksheet("S", [
  [cell.text("a"), cell.text("b"), cell.text("c"), cell.text("d")],
  [cell.number(1), cell.number(2), cell.number(3), cell.number(4)],
]);

/** The bytes of written content. */
const bytesOf = (c: Content): Uint8Array => {
  assert(Predicate.isTagged(c, "Bytes"), "the XLSX writer writes bytes");
  return c.bytes;
};

/** A workbook's first worksheet part, as text. */
const sheetXml = (data: Uint8Array): string =>
  strFromU8(unzipSync(data)["xl/worksheets/sheet1.xml"] ?? new Uint8Array());

/** `data` with its first worksheet part passed through `edit`. */
const editSheet = (data: Uint8Array, edit: (xml: string) => string): Uint8Array => {
  const files = unzipSync(data);
  return zipSync({ ...files, "xl/worksheets/sheet1.xml": strToU8(edit(sheetXml(data))) });
};

/** The first worksheet a read gives. */
const firstSheet = (data: Uint8Array) =>
  Effect.gen(function* () {
    const doc = yield* makeXlsxReader().read(bytes(data));
    const ws = doc.blocks[0];
    assert(ws !== undefined && Predicate.isTagged(ws, "Worksheet"), "a worksheet");
    return ws;
  });

describe("withSheetLayout (#66)", () => {
  test("is the worksheet new Worksheet builds: Equal, with the same keys in the same order", () => {
    const columns = [new SheetColumn({ width: 20 })];
    const merges = [merge(0, 0, 0, 1)];
    const attributed = new Worksheet({
      attr: { data: { kind: "x" } },
      name: "S",
      columns: [],
      rows: SHEET.rows,
      merges: [],
    });
    [SHEET, attributed].forEach((ws) => {
      const fast = withSheetLayout(ws, columns, merges);
      const slow =
        ws.attr === undefined
          ? new Worksheet({ name: ws.name, columns, rows: ws.rows, merges })
          : new Worksheet({ attr: ws.attr, name: ws.name, columns, rows: ws.rows, merges });
      expect(fast).toBeInstanceOf(Worksheet);
      expect(Equal.equals(fast, slow)).toBe(true);
      expect(Object.keys(fast)).toEqual(Object.keys(slow));
    });
  });

  test("takes columns and merges that are not instances as new Worksheet does", () => {
    // a plain object has MergeRange's shape but is not one
    const plain = [{ fromRow: 0, fromCol: 0, toRow: 0, toCol: 1 }];
    const viaLayout = Result.try(() => withSheetLayout(SHEET, [], plain));
    const viaNew = Result.try(
      () => new Worksheet({ name: "S", columns: [], rows: SHEET.rows, merges: plain }),
    );
    // the same worksheet or the same failure
    const outcome = (r: typeof viaNew) => Result.mapError(r, (e) => String(e));
    expect(outcome(viaLayout)).toEqual(outcome(viaNew));
  });
});

describe("XLSX column widths and merged ranges (#66)", () => {
  it.effect("round-trip, consecutive columns of one width as one <col>", () =>
    Effect.gen(function* () {
      const columns = [
        new SheetColumn({ width: 20 }),
        new SheetColumn({}),
        new SheetColumn({ width: 8.5 }),
        new SheetColumn({ width: 8.5 }),
      ];
      const merges = [merge(0, 0, 0, 1), merge(0, 2, 1, 3)];
      const written = bytesOf(
        yield* makeXlsxWriter().write(trustAs(document([withSheetLayout(SHEET, columns, merges)]))),
      );
      const xml = sheetXml(written);
      expect(xml).toContain(
        '<cols><col min="1" max="1" width="20" customWidth="1"/><col min="3" max="4" width="8.5" customWidth="1"/></cols><sheetData>',
      );
      expect(xml).toContain(
        '</sheetData><mergeCells count="2"><mergeCell ref="A1:B1"/><mergeCell ref="C1:D2"/></mergeCells></worksheet>',
      );
      const back = yield* firstSheet(written);
      expect(back.columns).toEqual(columns);
      expect(back.merges).toEqual(merges);
      expect(back.rows).toHaveLength(SHEET.rows.length);
    }),
  );

  it.effect("a sheet without either writes neither and reads back none", () =>
    Effect.gen(function* () {
      const written = bytesOf(yield* makeXlsxWriter().write(trustAs(document([SHEET]))));
      expect(sheetXml(written)).not.toMatch(/<cols>|<mergeCells/);
      const back = yield* firstSheet(written);
      expect(back.columns).toEqual([]);
      expect(back.merges).toEqual([]);
    }),
  );

  it.effect(
    "reads Excel's ranges: a range to the last column is cut there, a <col> without a width adds nothing",
    () =>
      Effect.gen(function* () {
        const written = bytesOf(yield* makeXlsxWriter().write(trustAs(document([SHEET]))));
        const edited = editSheet(written, (xml) =>
          xml.replace(
            "<sheetData>",
            '<cols><col min="1" max="1" style="3"/><col min="2" max="20000" width="9" customWidth="1"/></cols><sheetData>',
          ),
        );
        const back = yield* firstSheet(edited);
        expect(back.columns).toHaveLength(MAX_COLUMNS);
        expect(back.columns[0]).toEqual(new SheetColumn({}));
        expect(back.columns[1]).toEqual(new SheetColumn({ width: 9 }));
        expect(back.columns.at(-1)).toEqual(new SheetColumn({ width: 9 }));
      }),
  );

  it.effect("reads a merge's corners in either order, and a lone cell as a 1×1 range", () =>
    Effect.gen(function* () {
      const written = bytesOf(yield* makeXlsxWriter().write(trustAs(document([SHEET]))));
      const edited = editSheet(written, (xml) =>
        xml.replace(
          "</sheetData>",
          '</sheetData><mergeCells count="2"><mergeCell ref="B2:A1"/><mergeCell ref="C1"/></mergeCells>',
        ),
      );
      expect((yield* firstSheet(edited)).merges).toEqual([merge(0, 0, 1, 1), merge(0, 2, 0, 2)]);
    }),
  );

  it.effect("a merge ref that is not an A1 range fails the read with the sheet's name", () =>
    Effect.gen(function* () {
      const written = bytesOf(yield* makeXlsxWriter().write(trustAs(document([SHEET]))));
      const edited = editSheet(written, (xml) =>
        xml.replace(
          "</sheetData>",
          '</sheetData><mergeCells count="1"><mergeCell ref="nonsense"/></mergeCells>',
        ),
      );
      const error = yield* Effect.flip(makeXlsxReader().read(bytes(edited)));
      expect(error.reason).toContain('Worksheet "S"');
      expect(error.reason).toContain('"nonsense"');
    }),
  );

  it.effect("a preview read keeps only the merges over the rows it kept, clipped to the last", () =>
    Effect.gen(function* () {
      const tall = worksheet("S", [
        ["a", "b"],
        ["c", "d"],
        ["e", "f"],
        ["g", "h"],
      ]);
      const merges = [merge(0, 0, 0, 1), merge(1, 0, 3, 0), merge(3, 1, 3, 1)];
      const written = bytesOf(
        yield* makeXlsxWriter().write(trustAs(document([withSheetLayout(tall, [], merges)]))),
      );
      const doc = yield* makeXlsxReader({ maxRows: 2 }).read(bytes(written));
      const ws = doc.blocks[0];
      assert(ws !== undefined && Predicate.isTagged(ws, "Worksheet"), "a worksheet");
      expect(ws.merges).toEqual([merge(0, 0, 0, 1), merge(1, 0, 1, 0)]);
    }),
  );

  it.effect("a bad merge ref's ParseError is MalformedXml, at its sheet and part", () =>
    Effect.gen(function* () {
      const written = bytesOf(yield* makeXlsxWriter().write(trustAs(document([SHEET]))));
      const edited = editSheet(written, (xml) =>
        xml.replace(
          "</sheetData>",
          '</sheetData><mergeCells count="1"><mergeCell ref="nonsense"/></mergeCells>',
        ),
      );
      const error = yield* Effect.flip(makeXlsxReader().read(bytes(edited)));
      expect(error).toMatchObject({ code: "MalformedXml", position: { sheet: "S" } });
    }),
  );

  it.effect("the writer refuses a merge whose corners are not cell positions", () =>
    Effect.gen(function* () {
      const bad = [merge(0, 0, -1, 2), merge(1.5, 0, 2, 2), merge(2, 2, 1, 1)];
      yield* Effect.forEach(
        bad,
        (m) =>
          Effect.gen(function* () {
            const error = yield* Effect.flip(
              makeXlsxWriter().write(trustAs(document([withSheetLayout(SHEET, [], [m])]))),
            );
            expect(error._tag).toBe("WriteError");
          }),
        { concurrency: "unbounded" },
      );
    }),
  );
});

/** Each row's index, height and cell count, whatever its form. */
const shape = (ws: Worksheet) =>
  rowsOf(ws).map((r) => [r.index, r.height, r.cells.length] as const);

describe("XLSX custom row heights (#66)", () => {
  const HEIGHTS = worksheetFromRows("S", [
    sheetRow(0, [cell.text("tall")], 30),
    ["plain"],
    sheetRow(3, [], 12.5),
    sheetRow(4, [cell.number(1)]),
  ]);

  it.effect("round-trip, a row with only a height included, with ht and customHeight", () =>
    Effect.gen(function* () {
      const written = bytesOf(yield* makeXlsxWriter().write(trustAs(document([HEIGHTS]))));
      const xml = sheetXml(written);
      expect(xml).toContain('<row r="1" ht="30" customHeight="1">');
      expect(xml).toContain('<row r="4" ht="12.5" customHeight="1"></row>');
      expect(xml).toContain('<row r="2">');
      const back = yield* firstSheet(written);
      expect(shape(back)).toEqual(shape(HEIGHTS));
      // the row after a height row still follows on, so it stays plain
      expect(Array.isArray(back.rows[1])).toBe(true);
    }),
  );

  it.effect("the scanner's path and the tree's give the same heights", () =>
    Effect.gen(function* () {
      const written = bytesOf(yield* makeXlsxWriter().write(trustAs(document([HEIGHTS]))));
      // a comment before sheetData leaves the whole part to the tree path
      const viaTree = yield* firstSheet(
        editSheet(written, (xml) => xml.replace("<sheetData>", "<!-- tree --><sheetData>")),
      );
      const viaScanner = yield* firstSheet(written);
      expect(shape(viaTree)).toEqual(shape(viaScanner));
    }),
  );

  it.effect('keeps only heights marked custom, and reads customHeight="true"', () =>
    Effect.gen(function* () {
      const written = bytesOf(yield* makeXlsxWriter().write(trustAs(document([SHEET]))));
      const edited = editSheet(written, (xml) =>
        xml
          .replace('<row r="1">', '<row r="1" ht="15">')
          .replace('<row r="2">', `<row r="2" ht='20' customHeight='true'>`),
      );
      const back = yield* firstSheet(edited);
      expect(shape(back)).toEqual([
        [0, undefined, 4],
        [1, 20, 4],
      ]);
    }),
  );

  it.effect("a row with only a height counts toward maxCells", () =>
    Effect.gen(function* () {
      const tall = worksheetFromRows(
        "S",
        Array.from({ length: 5 }, (_, i) => sheetRow(i, [], 20)),
      );
      const written = bytesOf(yield* makeXlsxWriter().write(trustAs(document([tall]))));
      const error = yield* Effect.flip(makeXlsxReader({ maxCells: 4 }).read(bytes(written)));
      expect(error.code).toBe("LimitExceeded");
      expect(rowsOf(yield* firstSheet(written))).toHaveLength(5);
    }),
  );

  it.effect("the writer refuses a height that is not a finite, non-negative number", () =>
    Effect.forEach(
      [Number.NaN, -1, Infinity],
      (height) =>
        Effect.gen(function* () {
          const error = yield* Effect.flip(
            makeXlsxWriter().write(
              trustAs(document([worksheetFromRows("S", [sheetRow(0, ["x"], height)])])),
            ),
          );
          expect(error.reason).toContain("row height");
        }),
      { concurrency: "unbounded" },
    ),
  );
});
