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
  SheetColumn,
  trustAs,
  withSheetLayout,
  Worksheet,
  worksheet,
} from "@thomasfosterau/effect-document";
import { makeXlsxReader, makeXlsxWriter } from "../../../src/ooxml/xlsx/index.ts";
import { MAX_COLUMNS } from "../../../src/ooxml/xlsx/layout.ts";

const run = <A, E>(e: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(e);

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
const firstSheet = async (data: Uint8Array): Promise<Worksheet> => {
  const doc = await run(makeXlsxReader().read(bytes(data)));
  const ws = doc.blocks[0];
  assert(ws !== undefined && Predicate.isTagged(ws, "Worksheet"), "a worksheet");
  return ws;
};

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
  test("round-trip, consecutive columns of one width as one <col>", async () => {
    const columns = [
      new SheetColumn({ width: 20 }),
      new SheetColumn({}),
      new SheetColumn({ width: 8.5 }),
      new SheetColumn({ width: 8.5 }),
    ];
    const merges = [merge(0, 0, 0, 1), merge(0, 2, 1, 3)];
    const written = bytesOf(
      await run(
        makeXlsxWriter().write(trustAs(document([withSheetLayout(SHEET, columns, merges)]))),
      ),
    );
    const xml = sheetXml(written);
    expect(xml).toContain(
      '<cols><col min="1" max="1" width="20" customWidth="1"/><col min="3" max="4" width="8.5" customWidth="1"/></cols><sheetData>',
    );
    expect(xml).toContain(
      '</sheetData><mergeCells count="2"><mergeCell ref="A1:B1"/><mergeCell ref="C1:D2"/></mergeCells></worksheet>',
    );
    const back = await firstSheet(written);
    expect(back.columns).toEqual(columns);
    expect(back.merges).toEqual(merges);
    expect(back.rows).toHaveLength(SHEET.rows.length);
  });

  test("a sheet without either writes neither and reads back none", async () => {
    const written = bytesOf(await run(makeXlsxWriter().write(trustAs(document([SHEET])))));
    expect(sheetXml(written)).not.toMatch(/<cols>|<mergeCells/);
    const back = await firstSheet(written);
    expect(back.columns).toEqual([]);
    expect(back.merges).toEqual([]);
  });

  test("reads Excel's ranges: a range to the last column is cut there, a <col> without a width adds nothing", async () => {
    const written = bytesOf(await run(makeXlsxWriter().write(trustAs(document([SHEET])))));
    const edited = editSheet(written, (xml) =>
      xml.replace(
        "<sheetData>",
        '<cols><col min="1" max="1" style="3"/><col min="2" max="20000" width="9" customWidth="1"/></cols><sheetData>',
      ),
    );
    const back = await firstSheet(edited);
    expect(back.columns).toHaveLength(MAX_COLUMNS);
    expect(back.columns[0]).toEqual(new SheetColumn({}));
    expect(back.columns[1]).toEqual(new SheetColumn({ width: 9 }));
    expect(back.columns.at(-1)).toEqual(new SheetColumn({ width: 9 }));
  });

  test("reads a merge's corners in either order, and a lone cell as a 1×1 range", async () => {
    const written = bytesOf(await run(makeXlsxWriter().write(trustAs(document([SHEET])))));
    const edited = editSheet(written, (xml) =>
      xml.replace(
        "</sheetData>",
        '</sheetData><mergeCells count="2"><mergeCell ref="B2:A1"/><mergeCell ref="C1"/></mergeCells>',
      ),
    );
    expect((await firstSheet(edited)).merges).toEqual([merge(0, 0, 1, 1), merge(0, 2, 0, 2)]);
  });

  test("a merge ref that is not an A1 range fails the read with the sheet's name", async () => {
    const written = bytesOf(await run(makeXlsxWriter().write(trustAs(document([SHEET])))));
    const edited = editSheet(written, (xml) =>
      xml.replace(
        "</sheetData>",
        '</sheetData><mergeCells count="1"><mergeCell ref="nonsense"/></mergeCells>',
      ),
    );
    const error = await run(Effect.flip(makeXlsxReader().read(bytes(edited))));
    expect(error.reason).toContain('Worksheet "S"');
    expect(error.reason).toContain('"nonsense"');
  });

  test("the writer refuses a merge whose corners are not cell positions", async () => {
    const bad = [merge(0, 0, -1, 2), merge(1.5, 0, 2, 2), merge(2, 2, 1, 1)];
    await Promise.all(
      bad.map(async (m) => {
        const error = await run(
          Effect.flip(makeXlsxWriter().write(trustAs(document([withSheetLayout(SHEET, [], [m])])))),
        );
        expect(error._tag).toBe("WriteError");
      }),
    );
  });
});
