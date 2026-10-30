import * as Predicate from "effect/Predicate";
import { assert, describe, expect, test } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import {
  bytes,
  cell,
  cellToText,
  denseRows,
  type SheetCell,
  sheetExtent,
  type Doc,
  document,
  trustAs,
  worksheet,
  Worksheet,
} from "@thomasfosterau/effect-document";
import {
  makeXlsxReader,
  makeXlsxWriter,
  sanitizeSheetNames,
  type XlsxFeature,
  type XlsxReadFeature,
} from "../../src/xlsx/index.ts";
import { Spreadsheet } from "@thomasfosterau/effect-document/profiles";

const run = <A, E>(e: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(e);
type SpreadsheetF = XlsxFeature;

const worksheets = (doc: { blocks: ReadonlyArray<{ _tag: string }> }): Worksheet[] =>
  doc.blocks.filter((b) => Predicate.isTagged(b, "Worksheet")) as Worksheet[];

/** A worksheet's dense grid, for positional assertions. */
const grid = (ws: Worksheet) => {
  const rows = denseRows(ws);
  assert(Result.isSuccess(rows), "the grid fits the default budget");
  return rows.success;
};

const NS_MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const NS_PKG = "http://schemas.openxmlformats.org/package/2006/relationships";
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

const sheetXml = (body: string, head = "") =>
  `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="${NS_MAIN}">${head}` +
  `<sheetData>${body}</sheetData></worksheet>`;

/**
 * Build a package from worksheet XML. A string is a single sheet "S"; extra
 * sheets may name another relationship type (e.g. "chartsheet").
 */
const packageWith = (
  sheets: string | ReadonlyArray<{ name: string; xml: string; type?: string }>,
  sharedStrings?: string,
) => {
  const list = Predicate.isString(sheets) ? [{ name: "S", xml: sheets }] : sheets;
  const files = {
    "_rels/.rels": strToU8(
      `<Relationships xmlns="${NS_PKG}"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    ),
    "xl/workbook.xml": strToU8(
      `<workbook xmlns="${NS_MAIN}" xmlns:r="${REL}"><sheets>` +
        list
          .map((s, i) => `<sheet name="${s.name}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
          .join("") +
        `</sheets></workbook>`,
    ),
    "xl/_rels/workbook.xml.rels": strToU8(
      `<Relationships xmlns="${NS_PKG}">` +
        list
          .map(
            (s, i) =>
              `<Relationship Id="rId${i + 1}" Type="${s.type?.includes("://") ? s.type : `${REL}/${s.type ?? "worksheet"}`}" Target="worksheets/sheet${i + 1}.xml"/>`,
          )
          .join("") +
        (sharedStrings === undefined
          ? ""
          : `<Relationship Id="rIdS" Type="${REL}/sharedStrings" Target="sharedStrings.xml"/>`) +
        `</Relationships>`,
    ),
    ...Object.fromEntries(list.map((s, i) => [`xl/worksheets/sheet${i + 1}.xml`, strToU8(s.xml)])),
  };
  return bytes(
    zipSync(
      sharedStrings === undefined
        ? files
        : {
            ...files,
            "xl/sharedStrings.xml": strToU8(`<sst xmlns="${NS_MAIN}">${sharedStrings}</sst>`),
          },
    ),
  );
};

describe("XLSX round-trip", () => {
  test("preserves typed cells across write -> read", async () => {
    const doc = trustAs<SpreadsheetF>(
      document([
        worksheet("People", [
          [cell.text("alice"), cell.number(30), cell.boolean(true)],
          [cell.text("bob"), cell.number(25), cell.blank()],
        ]),
      ]),
    );
    const xlsx = await run(makeXlsxWriter().write(doc));
    expect(xlsx._tag).toBe("Bytes");

    const back = await run(makeXlsxReader().read(xlsx));
    const ws = worksheets(back)[0]!;
    expect(ws.name).toBe("People");
    expect(grid(ws)[0]![0]).toMatchObject({ _tag: "CellText", value: "alice" });
    expect(grid(ws)[0]![1]).toMatchObject({ _tag: "CellNumber", value: 30 });
    expect(grid(ws)[0]![2]).toMatchObject({ _tag: "CellBoolean", value: true });
  });

  test("preserves multiple sheets", async () => {
    const doc = trustAs<SpreadsheetF>(
      document([worksheet("A", [[cell.number(1)]]), worksheet("B", [[cell.number(2)]])]),
    );
    const xlsx = await run(makeXlsxWriter().write(doc));
    const back = await run(makeXlsxReader().read(xlsx));
    expect(worksheets(back).map((w) => w.name)).toEqual(["A", "B"]);
  });

  test("reader output conforms to the Spreadsheet profile", async () => {
    const doc = trustAs<SpreadsheetF>(document([worksheet("S", [[cell.error("#DIV/0!")]])]));
    const xlsx = await run(makeXlsxWriter().write(doc));
    const back: Doc<XlsxReadFeature> = await run(makeXlsxReader().read(xlsx));
    expect(Spreadsheet.is(back)).toBe(true);
    expect(grid(worksheets(back)[0]!)[0]![0]).toMatchObject({ _tag: "CellError" });
  });

  test("round-trips a formula cell as CellFormula (not flattened text)", async () => {
    const doc = trustAs<SpreadsheetF>(document([worksheet("S", [[cell.formula("A1+1", "42")]])]));
    const xlsx = await run(makeXlsxWriter().write(doc));
    const back = await run(makeXlsxReader().read(xlsx));
    expect(grid(worksheets(back)[0]!)[0]![0]).toMatchObject({
      _tag: "CellFormula",
      formula: "A1+1",
      result: "42",
    });
  });

  test("blank cells are neither written nor read back: the sheet is sparse", async () => {
    const doc = trustAs<SpreadsheetF>(
      document([
        worksheet("S", [
          [cell.text("a"), cell.text("b"), cell.blank()],
          [cell.blank(), cell.blank(), cell.blank()],
          [cell.blank(), cell.text("d")],
        ]),
      ]),
    );
    const xlsx = await run(makeXlsxWriter().write(doc));
    assert(Predicate.isTagged(xlsx, "Bytes"));
    const sheet = strFromU8(unzipSync(xlsx.bytes)["xl/worksheets/sheet1.xml"]!);
    expect(sheet).toContain(`<dimension ref="A1:C3"/>`);
    expect(sheet.match(/<c /g)).toHaveLength(3);
    const ws = worksheets(await run(makeXlsxReader().read(xlsx)))[0]!;
    expect(ws.rows.map((r) => [r.index, r.cells.map((c) => c.col)])).toEqual([
      [0, [0, 1]],
      [2, [1]],
    ]);
  });
});

describe("XLSX reader sparse worksheets (#62, #185)", () => {
  const extent = (ws: Worksheet) => {
    const { rows, columns } = sheetExtent(ws);
    return [rows, columns];
  };
  const held = (ws: Worksheet) => ws.rows.reduce((n, r) => n + r.cells.length, 0);

  test("empty rows and style-only cells are not kept", async () => {
    const xlsx = packageWith(
      sheetXml(
        `<row r="1"><c r="A1"><v>1</v></c><c r="Z1" s="3"/></row>` +
          `<row r="50000"/>` +
          `<row r="1048576"><c r="XFD1048576" s="2"/></row>`,
      ),
    );
    const ws = worksheets(await run(makeXlsxReader().read(xlsx)))[0]!;
    expect(extent(ws)).toEqual([1, 1]);
    expect(held(ws)).toBe(1);
  });

  test("a value at A1 and one far out hold two cells, not their extent", async () => {
    const xlsx = packageWith(
      sheetXml(
        `<row r="1"><c r="A1"><v>1</v></c></row>` +
          `<row r="1048576"><c r="XFD1048576"><v>2</v></c></row>`,
      ),
    );
    const ws = worksheets(await run(makeXlsxReader({ maxCells: 2 }).read(xlsx)))[0]!;
    expect(held(ws)).toBe(2);
    expect(extent(ws)).toEqual([1_048_576, 16_384]);
    expect(ws.rows.map((r) => [r.index, r.cells[0]!.col])).toEqual([
      [0, 0],
      [1_048_575, 16_383],
    ]);
  });

  test("rows and cells out of document order read back ascending", async () => {
    const xlsx = packageWith(
      sheetXml(
        `<row r="3"><c r="C3"><v>3</v></c><c r="A3"><v>1</v></c></row>` +
          `<row r="1"><c r="B1"><v>2</v></c></row>`,
      ),
    );
    const ws = worksheets(await run(makeXlsxReader().read(xlsx)))[0]!;
    expect(ws.rows.map((r) => [r.index, r.cells.map((c) => c.col)])).toEqual([
      [0, [1]],
      [2, [0, 2]],
    ]);
  });

  test("maxCells counts valued cells and is configurable", async () => {
    const xlsx = packageWith(
      sheetXml(
        `<row r="10"><c r="A10"><v>1</v></c><c r="J10"><v>2</v></c><c r="Z10" s="1"/></row>`,
      ),
    );
    const error = await run(Effect.flip(makeXlsxReader({ maxCells: 1 }).read(xlsx)));
    expect(error._tag).toBe("ParseError");
    expect(error.reason).toContain("maxCells");
    const ws = worksheets(await run(makeXlsxReader({ maxCells: 2 }).read(xlsx)))[0]!;
    expect(held(ws)).toBe(2);
  });

  test("<dimension> is only a hint and is not read", async () => {
    const body = `<row r="1"><c r="A1"><v>1</v></c></row>`;
    for (const ref of ["A1:C2", "A1:XFD1048576"]) {
      const xlsx = packageWith(sheetXml(body, `<dimension ref="${ref}"/>`));
      const ws = worksheets(await run(makeXlsxReader({ maxCells: 1 }).read(xlsx)))[0]!;
      expect(extent(ws)).toEqual([1, 1]);
    }
  });

  test("maxCells bounds the whole workbook, not each sheet", async () => {
    // Each sheet holds two valued cells, under the limit on its own; together they are not.
    const sheet = sheetXml(`<row r="10"><c r="A10"><v>1</v></c><c r="E10"><v>2</v></c></row>`);
    const xlsx = packageWith([
      { name: "A", xml: sheet },
      { name: "B", xml: sheet },
      { name: "C", xml: sheet },
    ]);
    const error = await run(Effect.flip(makeXlsxReader({ maxCells: 5 }).read(xlsx)));
    expect(error._tag).toBe("ParseError");
    expect(error.reason).toContain('"C"');
    expect(error.reason).toContain("maxCells");
    const read = worksheets(await run(makeXlsxReader({ maxCells: 6 }).read(xlsx)));
    expect(read.map(extent)).toEqual([
      [10, 5],
      [10, 5],
      [10, 5],
    ]);
  });
});

describe("XLSX reader fixes (#60)", () => {
  const readSheets = async (xlsx: ReturnType<typeof packageWith>) =>
    worksheets(await run(makeXlsxReader().read(xlsx)));
  const texts = (ws: Worksheet) => grid(ws).map((r) => r.map((c) => cellToText(c)));

  test("chartsheets, dialogsheets and macrosheets read as empty tagged sheets", async () => {
    const xlsx = packageWith([
      { name: "Data", xml: sheetXml(`<row r="1"><c r="A1"><v>1</v></c></row>`) },
      { name: "Chart", xml: `<chartsheet xmlns="${NS_MAIN}"/>`, type: "chartsheet" },
      { name: "Dialog", xml: `<dialogsheet xmlns="${NS_MAIN}"/>`, type: "dialogsheet" },
      {
        name: "Macro",
        xml: `<worksheet xmlns="${NS_MAIN}"/>`,
        type: "http://schemas.microsoft.com/office/2006/relationships/xlMacrosheet",
      },
    ]);
    const sheets = await readSheets(xlsx);
    expect(sheets.map((s) => s.name)).toEqual(["Data", "Chart", "Dialog", "Macro"]);
    expect(sheets.map((s) => s.attr?.data?.["kind"])).toEqual([
      undefined,
      "chartsheet",
      "dialogsheet",
      "macrosheet",
    ]);
    expect(sheets[1]!.rows).toEqual([]);
  });

  test("cells and rows without r follow the previous one", async () => {
    const xlsx = packageWith(
      sheetXml(
        `<row r="1"><c r="C1"><v>1</v></c><c><v>2</v></c></row>` +
          `<row><c><v>3</v></c><c><v>4</v></c></row>`,
      ),
    );
    expect(texts((await readSheets(xlsx))[0]!)).toEqual([
      ["", "", "1", "2"],
      ["3", "4", "", ""],
    ]);
  });

  test("shared formulas are translated to each dependent cell", async () => {
    const xlsx = packageWith(
      sheetXml(
        `<row r="1"><c r="C1"><f t="shared" ref="C1:D2" si="0">A1+$B1+B$1+SUM(A:A)+LOG10(A1)+"A1"</f><v>1</v></c>` +
          `<c r="D1"><f t="shared" si="0"/><v>2</v></c></row>` +
          `<row r="2"><c r="C2"><f t="shared" si="0"/><v>3</v></c></row>`,
      ),
    );
    const cells = grid((await readSheets(xlsx))[0]!);
    expect(cells[0]![2]).toMatchObject({ formula: `A1+$B1+B$1+SUM(A:A)+LOG10(A1)+"A1"` });
    expect(cells[0]![3]).toMatchObject({
      formula: `B1+$B1+C$1+SUM(B:B)+LOG10(B1)+"A1"`,
      result: "2",
    });
    expect(cells[1]![2]).toMatchObject({ formula: `A2+$B2+B$1+SUM(A:A)+LOG10(A2)+"A1"` });
  });

  test("phonetic guide text is not part of the string", async () => {
    const xlsx = packageWith(
      sheetXml(`<row r="1"><c r="A1" t="s"><v>0</v></c></row>`),
      `<si><t>東京</t><rPh sb="0" eb="2"><t>トウキョウ</t></rPh></si>`,
    );
    expect(texts((await readSheets(xlsx))[0]!)).toEqual([["東京"]]);
  });

  test("_xHHHH_ escapes are decoded", async () => {
    const xlsx = packageWith(
      sheetXml(
        `<row r="1"><c r="A1" t="s"><v>0</v></c>` +
          `<c r="B1" t="inlineStr"><is><t>tab_x0009_here _x005F_x0041_</t></is></c></row>`,
      ),
      `<si><t>line_x000D_break</t></si>`,
    );
    expect(texts((await readSheets(xlsx))[0]!)).toEqual([["line\rbreak", "tab\there _x0041_"]]);
  });

  test('t="d" cells read as dates', async () => {
    const xlsx = packageWith(
      sheetXml(`<row r="1"><c r="A1" t="d"><v>2024-03-05T00:00:00Z</v></c></row>`),
    );
    const c = grid((await readSheets(xlsx))[0]!)[0]![0]!;
    expect(c._tag).toBe("CellDate");
    expect(Predicate.isTagged(c, "CellDate") && c.value.toISOString()).toBe(
      "2024-03-05T00:00:00.000Z",
    );
  });
});

describe("XLSX writer validity (#61)", () => {
  const sheetDoc = (...sheets: Array<[string, SheetCell[][]]>) =>
    trustAs<SpreadsheetF>(document(sheets.map(([name, rows]) => worksheet(name, rows))));
  const parts = async (doc: Doc<SpreadsheetF>) => {
    const out = await run(makeXlsxWriter().write(doc));
    assert(Predicate.isTagged(out, "Bytes"), "expected bytes");
    const files = unzipSync(out.bytes);
    return (path: string) => (files[path] === undefined ? undefined : strFromU8(files[path]));
  };

  test("NaN and ±Infinity are written as #NUM! errors", async () => {
    const doc = sheetDoc(["S", [[cell.number(Number.NaN), cell.number(Infinity), cell.number(1)]]]);
    const part = await parts(doc);
    expect(part("xl/worksheets/sheet1.xml")).not.toContain("NaN");
    const back = worksheets(
      await run(makeXlsxReader().read(await run(makeXlsxWriter().write(doc)))),
    );
    expect(grid(back[0]!)[0]!.map((c) => c._tag)).toEqual(["CellError", "CellError", "CellNumber"]);
    expect(grid(back[0]!)[0]![0]).toMatchObject({ value: "#NUM!" });
  });

  test("characters invalid in XML are _xHHHH_-encoded and round-trip", async () => {
    const tricky = "a\u0001b\u001Fc\td\ne_x0041_f\uD800g";
    const doc = sheetDoc(["S", [[cell.text(tricky), cell.formula(`"\u0002"`, "\u0003")]]]);
    const part = await parts(doc);
    const sst = part("xl/sharedStrings.xml")!;
    expect(sst).toContain("a_x0001_b_x001F_c\td\ne_x005F_x0041_f_xD800_g");
    // oxlint-disable-next-line eslint/no-control-regex -- asserts no C0 control survives the encoding
    expect(/[\u0000-\u0008]/.test(sst + part("xl/worksheets/sheet1.xml"))).toBe(false);
    const back = worksheets(
      await run(makeXlsxReader().read(await run(makeXlsxWriter().write(doc)))),
    );
    expect(grid(back[0]!)[0]![0]).toMatchObject({ value: tricky });
    expect(grid(back[0]!)[0]![1]).toMatchObject({ formula: `"\u0002"`, result: "\u0003" });
  });

  test("sheet names are sanitised deterministically", () => {
    expect(
      sanitizeSheetNames([
        "a[b]:c*?/\\d",
        "",
        "History",
        "data",
        "DATA",
        "x".repeat(40),
        "x".repeat(40),
        "'q'",
      ]),
    ).toEqual([
      "a_b__c____d",
      "Sheet2",
      "History_",
      "data",
      "DATA (2)",
      "x".repeat(31),
      `${"x".repeat(27)} (2)`,
      "q",
    ]);
  });

  test("written sheet names are the sanitised ones", async () => {
    const back = worksheets(
      await run(
        makeXlsxReader().read(
          await run(
            makeXlsxWriter().write(
              sheetDoc(["A/B", [[cell.number(1)]]], ["a/b", [[cell.number(2)]]]),
            ),
          ),
        ),
      ),
    );
    expect(back.map((w) => w.name)).toEqual(["A_B", "a_b (2)"]);
  });

  test("a leading = is stripped from formulas", async () => {
    const part = await parts(sheetDoc(["S", [[cell.formula("=A1+1", "2")]]]));
    expect(part("xl/worksheets/sheet1.xml")).toContain("<f>A1+1</f>");
  });

  test("fullCalcOnLoad is set only when a formula lacks a cached result", async () => {
    expect(
      (await parts(sheetDoc(["S", [[cell.formula("1+1", "2")]]])))("xl/workbook.xml"),
    ).not.toContain("calcPr");
    expect((await parts(sheetDoc(["S", [[cell.formula("1+1")]]])))("xl/workbook.xml")).toContain(
      `<calcPr fullCalcOnLoad="1"/>`,
    );
  });

  test("sst count is the reference count and uniqueCount the distinct count", async () => {
    const part = await parts(sheetDoc(["S", [[cell.text("a"), cell.text("a"), cell.text("b")]]]));
    expect(part("xl/sharedStrings.xml")).toContain(`count="3" uniqueCount="2"`);
  });

  test("docProps core.xml and app.xml are written and related", async () => {
    const part = await parts(sheetDoc(["S", [[cell.number(1)]]]));
    expect(part("docProps/core.xml")).toContain("coreProperties");
    expect(part("docProps/app.xml")).toContain("<Application>");
    expect(part("_rels/.rels")).toContain(`Target="docProps/core.xml"`);
    expect(part("[Content_Types].xml")).toContain(`PartName="/docProps/app.xml"`);
  });

  test("random grids with edge-case values round-trip", async () => {
    // A small seeded generator (no property-testing dependency).
    let seed = 42;
    const rand = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    const pick = <A>(xs: ReadonlyArray<A>): A => xs[Math.floor(rand() * xs.length)]!;
    const texts = ["", "plain", "_x0041_", "\u0000\u0007", "\uDC00", "<&>\"'", "東京", " lead"];
    for (let round = 0; round < 25; round++) {
      const rows = Array.from({ length: 1 + Math.floor(rand() * 5) }, () =>
        Array.from({ length: 1 + Math.floor(rand() * 5) }, () =>
          pick([
            () => cell.text(pick(texts)),
            () => cell.number(pick([0, -1.5, 1e300, 42])),
            () => cell.boolean(rand() < 0.5),
            () => cell.blank(),
          ])(),
        ),
      );
      const doc = sheetDoc([pick(["S", "a:b", "History", ""]), rows]);
      const back = worksheets(
        await run(makeXlsxReader().read(await run(makeXlsxWriter().write(doc)))),
      )[0]!;
      const width = Math.max(...rows.map((r) => r.length));
      const expected = rows.map((r) =>
        Array.from({ length: width }, (_, c) => (r[c] === undefined ? "" : cellToText(r[c]))),
      );
      // Blank cells are not written, so the sheet reads back as the valued cells alone.
      expect(back.rows.every((r) => r.cells.every((c) => c.cell._tag !== "CellBlank"))).toBe(true);
      const backGrid = grid(back);
      const actual = expected.map((r, ri) =>
        r.map((_, ci) => {
          const c = backGrid[ri]?.[ci];
          return c === undefined ? "" : cellToText(c);
        }),
      );
      expect(actual).toEqual(expected);
      const { rows: h, columns: w } = sheetExtent(back);
      expect(h <= rows.length && w <= width).toBe(true);
    }
  });
});
