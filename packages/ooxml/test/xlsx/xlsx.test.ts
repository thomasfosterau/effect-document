import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { strToU8, zipSync } from "fflate";
import {
  bytes, cell, cellToText, type Doc, document, type FeaturesOf, trustAs, worksheet, Worksheet,
} from "@thomasfosterau/effect-document";
import { makeXlsxReader, makeXlsxWriter, type XlsxFeature, type XlsxReadFeature } from "../../src/xlsx/index.js";
import { Spreadsheet } from "@thomasfosterau/effect-document/profiles";

const run = <A, E>(e: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(e);
type SpreadsheetF = XlsxFeature;

const worksheets = (doc: { blocks: ReadonlyArray<{ _tag: string }> }): Worksheet[] =>
  doc.blocks.filter((b) => b._tag === "Worksheet") as Worksheet[];

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
  sharedStrings?: string
) => {
  const list = typeof sheets === "string" ? [{ name: "S", xml: sheets }] : sheets;
  const files: Record<string, Uint8Array> = {
    "_rels/.rels": strToU8(
      `<Relationships xmlns="${NS_PKG}"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`
    ),
    "xl/workbook.xml": strToU8(
      `<workbook xmlns="${NS_MAIN}" xmlns:r="${REL}"><sheets>` +
        list.map((s, i) => `<sheet name="${s.name}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("") +
        `</sheets></workbook>`
    ),
    "xl/_rels/workbook.xml.rels": strToU8(
      `<Relationships xmlns="${NS_PKG}">` +
        list
          .map((s, i) => `<Relationship Id="rId${i + 1}" Type="${s.type?.includes("://") ? s.type : `${REL}/${s.type ?? "worksheet"}`}" Target="worksheets/sheet${i + 1}.xml"/>`)
          .join("") +
        (sharedStrings === undefined ? "" : `<Relationship Id="rIdS" Type="${REL}/sharedStrings" Target="sharedStrings.xml"/>`) +
        `</Relationships>`
    ),
  };
  list.forEach((s, i) => {
    files[`xl/worksheets/sheet${i + 1}.xml`] = strToU8(s.xml);
  });
  if (sharedStrings !== undefined) {
    files["xl/sharedStrings.xml"] = strToU8(`<sst xmlns="${NS_MAIN}">${sharedStrings}</sst>`);
  }
  return bytes(zipSync(files));
};

describe("XLSX round-trip", () => {
  test("preserves typed cells across write -> read", async () => {
    const doc = trustAs<SpreadsheetF>(
      document([
        worksheet("People", [
          [cell.text("alice"), cell.number(30), cell.boolean(true)],
          [cell.text("bob"), cell.number(25), cell.blank()],
        ]),
      ])
    );
    const xlsx = await run(makeXlsxWriter().write(doc));
    expect(xlsx._tag).toBe("Bytes");

    const back = await run(makeXlsxReader().read(xlsx));
    const ws = worksheets(back)[0]!;
    expect(ws.name).toBe("People");
    expect(ws.rows[0]!.cells[0]).toMatchObject({ _tag: "CellText", value: "alice" });
    expect(ws.rows[0]!.cells[1]).toMatchObject({ _tag: "CellNumber", value: 30 });
    expect(ws.rows[0]!.cells[2]).toMatchObject({ _tag: "CellBoolean", value: true });
  });

  test("preserves multiple sheets", async () => {
    const doc = trustAs<SpreadsheetF>(
      document([
        worksheet("A", [[cell.number(1)]]),
        worksheet("B", [[cell.number(2)]]),
      ])
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
    expect(worksheets(back)[0]!.rows[0]!.cells[0]).toMatchObject({ _tag: "CellError" });
  });

  test("round-trips a formula cell as CellFormula (not flattened text)", async () => {
    const doc = trustAs<SpreadsheetF>(
      document([worksheet("S", [[cell.formula("A1+1", "42")]])])
    );
    const xlsx = await run(makeXlsxWriter().write(doc));
    const back = await run(makeXlsxReader().read(xlsx));
    expect(worksheets(back)[0]!.rows[0]!.cells[0]).toMatchObject({
      _tag: "CellFormula",
      formula: "A1+1",
      result: "42",
    });
  });

  test("preserves grid width when the trailing column is all-blank", async () => {
    const doc = trustAs<SpreadsheetF>(
      document([
        worksheet("S", [
          [cell.text("a"), cell.text("b"), cell.blank()],
          [cell.text("c"), cell.text("d"), cell.blank()],
        ]),
      ])
    );
    const xlsx = await run(makeXlsxWriter().write(doc));
    const back = await run(makeXlsxReader().read(xlsx));
    expect(worksheets(back)[0]!.rows.map((r) => r.cells.length)).toEqual([3, 3]);
  });
});

describe("XLSX reader grid extent (#62)", () => {
  const extent = (ws: Worksheet) => [ws.rows.length, ws.rows[0]?.cells.length ?? 0];

  test("empty rows and style-only cells do not extend the grid", async () => {
    const xlsx = packageWith(
      sheetXml(
        `<row r="1"><c r="A1"><v>1</v></c><c r="Z1" s="3"/></row>` +
          `<row r="50000"/>` +
          `<row r="1048576"><c r="XFD1048576" s="2"/></row>`
      )
    );
    const ws = worksheets(await run(makeXlsxReader().read(xlsx)))[0]!;
    expect(extent(ws)).toEqual([1, 1]);
  });

  test("a valued cell far out fails with a ParseError instead of allocating", async () => {
    const xlsx = packageWith(sheetXml(`<row r="1048576"><c r="XFD1048576"><v>1</v></c></row>`));
    const error = await run(Effect.flip(makeXlsxReader().read(xlsx)));
    expect(error._tag).toBe("ParseError");
    expect(error.reason).toContain("maxCells");
  });

  test("maxCells is configurable", async () => {
    const xlsx = packageWith(sheetXml(`<row r="10"><c r="J10"><v>1</v></c></row>`));
    const error = await run(Effect.flip(makeXlsxReader({ maxCells: 99 }).read(xlsx)));
    expect(error._tag).toBe("ParseError");
    const ws = worksheets(await run(makeXlsxReader({ maxCells: 100 }).read(xlsx)))[0]!;
    expect(extent(ws)).toEqual([10, 10]);
  });

  test("<dimension> widens the grid but is ignored past the limit", async () => {
    const body = `<row r="1"><c r="A1"><v>1</v></c></row>`;
    const small = packageWith(sheetXml(body, `<dimension ref="A1:C2"/>`));
    expect(extent(worksheets(await run(makeXlsxReader().read(small)))[0]!)).toEqual([2, 3]);

    const huge = packageWith(sheetXml(body, `<dimension ref="A1:XFD1048576"/>`));
    expect(extent(worksheets(await run(makeXlsxReader().read(huge)))[0]!)).toEqual([1, 1]);
  });

  test("round-trips trailing blank rows and columns via <dimension>", async () => {
    const doc = trustAs<SpreadsheetF>(
      document([
        worksheet("S", [
          [cell.text("a"), cell.blank(), cell.blank()],
          [cell.blank(), cell.blank(), cell.blank()],
        ]),
      ])
    );
    const back = await run(makeXlsxReader().read(await run(makeXlsxWriter().write(doc))));
    expect(extent(worksheets(back)[0]!)).toEqual([2, 3]);
  });
});

describe("XLSX reader fixes (#60)", () => {
  const readSheets = async (xlsx: ReturnType<typeof packageWith>) =>
    worksheets(await run(makeXlsxReader().read(xlsx)));
  const grid = (ws: Worksheet) => ws.rows.map((r) => r.cells.map((c) => cellToText(c)));

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
      undefined, "chartsheet", "dialogsheet", "macrosheet",
    ]);
    expect(sheets[1]!.rows).toEqual([]);
  });

  test("cells and rows without r follow the previous one", async () => {
    const xlsx = packageWith(
      sheetXml(
        `<row r="1"><c r="C1"><v>1</v></c><c><v>2</v></c></row>` +
          `<row><c><v>3</v></c><c><v>4</v></c></row>`
      )
    );
    expect(grid((await readSheets(xlsx))[0]!)).toEqual([
      ["", "", "1", "2"],
      ["3", "4", "", ""],
    ]);
  });

  test("shared formulas are translated to each dependent cell", async () => {
    const xlsx = packageWith(
      sheetXml(
        `<row r="1"><c r="C1"><f t="shared" ref="C1:D2" si="0">A1+$B1+B$1+SUM(A:A)+LOG10(A1)+"A1"</f><v>1</v></c>` +
          `<c r="D1"><f t="shared" si="0"/><v>2</v></c></row>` +
          `<row r="2"><c r="C2"><f t="shared" si="0"/><v>3</v></c></row>`
      )
    );
    const cells = (await readSheets(xlsx))[0]!.rows.map((r) => r.cells);
    expect(cells[0]![2]).toMatchObject({ formula: `A1+$B1+B$1+SUM(A:A)+LOG10(A1)+"A1"` });
    expect(cells[0]![3]).toMatchObject({ formula: `B1+$B1+C$1+SUM(B:B)+LOG10(B1)+"A1"`, result: "2" });
    expect(cells[1]![2]).toMatchObject({ formula: `A2+$B2+B$1+SUM(A:A)+LOG10(A2)+"A1"` });
  });

  test("phonetic guide text is not part of the string", async () => {
    const xlsx = packageWith(
      sheetXml(`<row r="1"><c r="A1" t="s"><v>0</v></c></row>`),
      `<si><t>東京</t><rPh sb="0" eb="2"><t>トウキョウ</t></rPh></si>`
    );
    expect(grid((await readSheets(xlsx))[0]!)).toEqual([["東京"]]);
  });

  test("_xHHHH_ escapes are decoded", async () => {
    const xlsx = packageWith(
      sheetXml(
        `<row r="1"><c r="A1" t="s"><v>0</v></c>` +
          `<c r="B1" t="inlineStr"><is><t>tab_x0009_here _x005F_x0041_</t></is></c></row>`
      ),
      `<si><t>line_x000D_break</t></si>`
    );
    expect(grid((await readSheets(xlsx))[0]!)).toEqual([["line\rbreak", "tab\there _x0041_"]]);
  });

  test("t=\"d\" cells read as dates", async () => {
    const xlsx = packageWith(
      sheetXml(`<row r="1"><c r="A1" t="d"><v>2024-03-05T00:00:00Z</v></c></row>`)
    );
    const c = (await readSheets(xlsx))[0]!.rows[0]!.cells[0]!;
    expect(c._tag).toBe("CellDate");
    expect(c._tag === "CellDate" && c.value.toISOString()).toBe("2024-03-05T00:00:00.000Z");
  });
});
