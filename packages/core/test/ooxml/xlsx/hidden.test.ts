import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { assert, describe, expect, test } from "vite-plus/test";
import {
  bytes,
  type Content,
  document,
  rowsOf,
  SheetColumn,
  SheetRow,
  trustAs,
  withSheetLayout,
  Worksheet,
  worksheet,
  worksheetFromRows,
} from "@thomasfosterau/effect-document";
import { makeXlsxReader, makeXlsxWriter, type XlsxFeature } from "../../../src/ooxml/xlsx/index.ts";

const run = <A, E>(e: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(e);

/** The bytes of written content. */
const bytesOf = (c: Content): Uint8Array => {
  assert(Predicate.isTagged(c, "Bytes"), "the XLSX writer writes bytes");
  return c.bytes;
};

/** A part of a written workbook, as text. */
const partOf = (data: Uint8Array, path: string): string =>
  strFromU8(unzipSync(data)[path] ?? new Uint8Array());

/** `data` with its first worksheet part passed through `edit`. */
const editSheet = (data: Uint8Array, edit: (xml: string) => string): Uint8Array => {
  const path = "xl/worksheets/sheet1.xml";
  return zipSync({ ...unzipSync(data), [path]: strToU8(edit(partOf(data, path))) });
};

/** The worksheets a read gives. */
const sheetsOf = async (data: Uint8Array): Promise<ReadonlyArray<Worksheet>> =>
  (await run(makeXlsxReader().read(bytes(data)))).blocks.filter((b): b is Worksheet =>
    Predicate.isTagged(b, "Worksheet"),
  );

/** `blocks` written as a workbook. */
const write = async (blocks: ReadonlyArray<Worksheet>): Promise<Uint8Array> =>
  bytesOf(await run(makeXlsxWriter().write(trustAs<XlsxFeature>(document(blocks)))));

/** Each row's index and whether it is hidden. */
const hiddenRows = (ws: Worksheet) => rowsOf(ws).map((r) => [r.index, r.hidden === true]);

/** A sheet with a hidden row holding a cell, a hidden row with none, and two hidden columns. */
const HIDDEN = withSheetLayout(
  worksheetFromRows("S", [
    ["shown"],
    new SheetRow({ index: 1, cells: ["hidden"], hidden: true }),
    new SheetRow({ index: 3, cells: [], height: 20, hidden: true }),
    ["after"],
  ]),
  [
    new SheetColumn({ width: 12 }),
    new SheetColumn({ hidden: true }),
    new SheetColumn({ width: 8, hidden: true }),
  ],
  [],
);

describe("XLSX hidden rows and columns (#66)", () => {
  test('round-trip with hidden="1", an empty hidden row included', async () => {
    const written = await write([HIDDEN]);
    const xml = partOf(written, "xl/worksheets/sheet1.xml");
    expect(xml).toContain('<row r="2" hidden="1">');
    expect(xml).toContain('<row r="4" ht="20" customHeight="1" hidden="1"></row>');
    expect(xml).toContain(
      '<cols><col min="1" max="1" width="12" customWidth="1"/><col min="2" max="2" hidden="1"/><col min="3" max="3" width="8" customWidth="1" hidden="1"/></cols>',
    );
    const [back] = await sheetsOf(written);
    assert(back !== undefined);
    expect(hiddenRows(back)).toEqual(hiddenRows(HIDDEN));
    expect(rowsOf(back)[2]?.height).toBe(20);
    expect(back.columns).toEqual(HIDDEN.columns);
    // the row after a hidden one still follows on, so it stays plain
    expect(Array.isArray(back.rows.at(-1))).toBe(true);
  });

  test("the scanner's path and the tree's read the same hidden rows", async () => {
    const written = await write([HIDDEN]);
    // a comment before sheetData leaves the whole part to the tree path
    const [viaTree] = await sheetsOf(
      editSheet(written, (xml) => xml.replace("<sheetData>", "<!-- tree --><sheetData>")),
    );
    const [viaScanner] = await sheetsOf(written);
    assert(viaTree !== undefined && viaScanner !== undefined);
    expect(hiddenRows(viaTree)).toEqual(hiddenRows(viaScanner));
    expect(hiddenRows(viaScanner)).toEqual(hiddenRows(HIDDEN));
  });

  test('reads hidden="true" and leaves hidden="0" shown', async () => {
    const written = await write([worksheet("S", [["a"], ["b"], ["c"]])]);
    const edited = editSheet(written, (xml) =>
      xml
        .replace('<row r="1">', '<row r="1" hidden="0">')
        .replace('<row r="2">', `<row r="2" hidden='true'>`)
        .replace("<sheetData>", '<cols><col min="2" max="3" hidden="true"/></cols><sheetData>'),
    );
    const [back] = await sheetsOf(edited);
    assert(back !== undefined);
    expect(hiddenRows(back)).toEqual([
      [0, false],
      [1, true],
      [2, false],
    ]);
    expect(back.columns).toEqual([
      new SheetColumn({}),
      new SheetColumn({ hidden: true }),
      new SheetColumn({ hidden: true }),
    ]);
  });
});

describe("XLSX hidden worksheets (#66)", () => {
  const shown = worksheet("Shown", [["a"]]);
  const hidden = withSheetLayout(worksheet("Hidden", [["b"]]), [], [], "hidden");
  const veryHidden = withSheetLayout(worksheet("Very", [["c"]]), [], [], "veryHidden");

  test("round-trip state, opening on the first shown sheet when the first is hidden", async () => {
    const written = await write([hidden, shown, veryHidden]);
    const workbook = partOf(written, "xl/workbook.xml");
    expect(workbook).toContain('<sheet name="Hidden" sheetId="1" state="hidden" r:id="rId1"/>');
    expect(workbook).toContain('<sheet name="Shown" sheetId="2" r:id="rId2"/>');
    expect(workbook).toContain('state="veryHidden"');
    expect(workbook).toContain('<bookViews><workbookView activeTab="1"/></bookViews><sheets>');
    const back = await sheetsOf(written);
    expect(back.map((ws) => [ws.name, ws.visibility])).toEqual([
      ["Hidden", "hidden"],
      ["Shown", undefined],
      ["Very", "veryHidden"],
    ]);
  });

  test("a workbook whose first sheet is shown has no bookViews", async () => {
    const workbook = partOf(await write([shown, hidden]), "xl/workbook.xml");
    expect(workbook).not.toContain("bookViews");
  });

  test("the writer refuses a workbook with every sheet hidden", async () => {
    const error = await run(
      Effect.flip(makeXlsxWriter().write(trustAs<XlsxFeature>(document([hidden, veryHidden])))),
    );
    expect(error.reason).toContain("every worksheet is hidden");
  });

  test("withSheetLayout keeps a sheet's visibility unless given another", () => {
    expect(withSheetLayout(hidden, [new SheetColumn({ width: 9 })], []).visibility).toBe("hidden");
    expect(withSheetLayout(hidden, [], [], "veryHidden").visibility).toBe("veryHidden");
    expect(withSheetLayout(shown, [], []).visibility).toBeUndefined();
  });
});
