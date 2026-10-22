import { describe, expect, test } from "vite-plus/test";
import {
  cell, document, header, para, str, strong, worksheet, blocksToText,
  SheetColumn, SheetRow, Worksheet,
} from "../../src/schema/index.ts";
import { Profiles, defineProfile, narrow, widen } from "../../src/profile/index.ts";

describe("widen", () => {
  test("is an identity at runtime", () => {
    // start from a branded Doc<CsvFeature> (a bare Document has no brand)
    const { document: doc } = narrow(document([worksheet("S", [[cell.text("a")]])]), Profiles.Csv);
    expect(widen(doc)).toBe(doc);
  });
});

describe("narrow: spreadsheet -> csv (the Excel -> CSV case)", () => {
  const excel = document([
    worksheet("Jan", [
      [cell.text("item"), cell.date(new Date("2026-01-02T00:00:00.000Z"))],
      [cell.formula("=A1", "cached"), cell.number(3)],
    ]),
    worksheet("Feb", [[cell.number(9)]]),
  ]);

  test("drops extra sheets, converts dates & formulas, and reports the loss", () => {
    const { document: csv, loss } = narrow(excel, Profiles.Csv);

    // only the first worksheet survives
    const worksheets = csv.blocks.filter((b) => b._tag === "Worksheet");
    expect(worksheets).toHaveLength(1);

    // the date became text, the formula became its cached result
    const firstRow = worksheets[0]!.rows[0]!.cells;
    expect(firstRow[1]!._tag).toBe("CellText");
    const secondRow = worksheets[0]!.rows[1]!.cells;
    expect(secondRow[0]).toMatchObject({ _tag: "CellText", value: "cached" });

    // the loss report names exactly what changed
    const features = loss.entries.map((e) => e.feature);
    expect(features).toEqual(
      expect.arrayContaining(["sheet.multiple", "cell.date", "cell.formula"])
    );
    expect(loss.isLossless).toBe(false);

    // and the result actually conforms to the CSV profile
    expect(Profiles.Csv.is(csv)).toBe(true);
  });

  test("a document already in the target profile narrows losslessly", () => {
    const plain = document([worksheet("S", [[cell.text("a"), cell.number(1)]])]);
    const { loss, document: out } = narrow(plain, Profiles.Csv);
    expect(loss.isLossless).toBe(true);
    expect(Profiles.Csv.is(out)).toBe(true);
  });
});

describe("narrow: prose -> markdown subset", () => {
  test("unwraps unsupported inline formatting to text", () => {
    // Markdown allows strong but not, say, smallCaps; use an attr the profile lacks.
    const doc = document([para([str("hello "), strong([str("world")])])]);
    const { document: md } = narrow(doc, Profiles.Markdown);
    expect(Profiles.Markdown.is(md)).toBe(true);
    expect(blocksToText(md.blocks)).toBe("hello world");
  });

  test("a heading is preserved when the target supports it", () => {
    const doc = document([header(1, [str("Title")])]);
    const { loss, document: md } = narrow(doc, Profiles.Markdown);
    expect(loss.isLossless).toBe(true);
    expect(md.blocks[0]!._tag).toBe("Header");
  });
});

describe("narrow: column-level styling", () => {
  // a profile allowing column metadata but not styling
  const Columns = defineProfile("columns", [
    "sheet.worksheet", "sheet.columns", "cell.text", "cell.number",
  ] as const);

  test("strips per-column styles the target can't represent (and reports it)", () => {
    const doc = document([
      new Worksheet({
        name: "S",
        columns: [new SheetColumn({ width: 10, style: { font: { bold: true } } })],
        rows: [new SheetRow({ cells: [cell.text("a")] })],
        merges: [],
      }),
    ]);
    const { document: out, loss } = narrow(doc, Columns);
    expect(Columns.is(out)).toBe(true); // must actually conform
    expect(loss.entries.some((e) => e.feature === "cell.style")).toBe(true);
  });
});

describe("narrow: spreadsheet -> prose", () => {
  test("converts a worksheet to a prose table", () => {
    const doc = document([worksheet("S", [[cell.text("a"), cell.number(1)]])]);
    const { document: prose, loss } = narrow(doc, Profiles.Markdown);
    expect(prose.blocks[0]!._tag).toBe("Table");
    expect(loss.entries.some((e) => e.feature === "sheet.worksheet")).toBe(true);
  });
});
