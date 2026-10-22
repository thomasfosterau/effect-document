import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { strToU8, zipSync } from "fflate";
import {
  bytes, cell, type Doc, document, type FeaturesOf, trustAs, worksheet, Worksheet,
} from "@thomasfosterau/effect-document";
import { makeXlsxReader, makeXlsxWriter } from "../../src/xlsx/index.js";
import { Spreadsheet } from "@thomasfosterau/effect-document/profiles";

const run = <A, E>(e: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(e);
type SpreadsheetF = FeaturesOf<typeof Spreadsheet>;

const worksheets = (doc: { blocks: ReadonlyArray<{ _tag: string }> }): Worksheet[] =>
  doc.blocks.filter((b) => b._tag === "Worksheet") as Worksheet[];

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
    const back: Doc<SpreadsheetF> = await run(makeXlsxReader().read(xlsx));
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
  const sheetXml = (body: string, head = "") =>
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${head}` +
    `<sheetData>${body}</sheetData></worksheet>`;

  /** Build a one-sheet package around the given worksheet XML. */
  const packageWith = (worksheet: string) =>
    bytes(
      zipSync({
        "_rels/.rels": strToU8(
          `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
            `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>` +
            `</Relationships>`
        ),
        "xl/workbook.xml": strToU8(
          `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
            `<sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>`
        ),
        "xl/_rels/workbook.xml.rels": strToU8(
          `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
            `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>` +
            `</Relationships>`
        ),
        "xl/worksheets/sheet1.xml": strToU8(worksheet),
      })
    );

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
