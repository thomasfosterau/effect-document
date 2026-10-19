import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import {
  cell, contentToText, convert, document, type FeaturesOf, text, trustAs, worksheet, Worksheet,
} from "@thomasfosterau/effect-document";
import { Spreadsheet } from "@thomasfosterau/effect-document/profiles";
import * as Csv from "@thomasfosterau/effect-csv";
import * as Xlsx from "@thomasfosterau/effect-ooxml/xlsx";
import { makeXlsxReader, makeXlsxWriter } from "@thomasfosterau/effect-ooxml/xlsx";

type SpreadsheetF = FeaturesOf<typeof Spreadsheet>;

const run = <A, E>(e: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(e);

describe("convert", () => {
  test("CSV -> XLSX is a free widening (lossless)", async () => {
    const { content, loss } = await run(
      convert({ from: Csv.format, to: Xlsx.format, input: text("product,price\nLaptop,999.99\n") })
    );
    expect(content._tag).toBe("Bytes");
    expect(loss.isLossless).toBe(true);

    // sanity: the bytes are a real workbook we can read back
    const back = await run(makeXlsxReader().read(content));
    const ws = back.blocks.find((b) => b._tag === "Worksheet") as Worksheet;
    expect(ws.rows[1]!.cells[1]).toMatchObject({ _tag: "CellNumber", value: 999.99 });
  });

  test("XLSX -> CSV narrows, dropping nothing for representable data", async () => {
    // build an xlsx from csv, then convert back
    const { content: xlsx } = await run(
      convert({ from: Csv.format, to: Xlsx.format, input: text("a,b\n1,2\n") })
    );
    const { content: csv, loss } = await run(
      convert({ from: Xlsx.format, to: Csv.format, input: xlsx })
    );
    expect(contentToText(csv)).toBe("a,b\n1,2\n");
    expect(loss.isLossless).toBe(true);
  });

  test("XLSX -> CSV narrows lossily for multi-sheet input, reporting the loss", async () => {
    // a genuine two-sheet workbook
    const twoSheet = trustAs<SpreadsheetF>(
      document([
        worksheet("Jan", [[cell.text("a"), cell.number(1)]]),
        worksheet("Feb", [[cell.text("b"), cell.number(2)]]),
      ])
    );
    const xlsx = await run(makeXlsxWriter().write(twoSheet));

    const { content: csv, loss } = await run(
      convert({ from: Xlsx.format, to: Csv.format, input: xlsx })
    );

    expect(loss.isLossless).toBe(false);
    expect(loss.entries.some((e) => e.feature === "sheet.multiple")).toBe(true);
    // only the first sheet's data reaches CSV
    expect(contentToText(csv)).toBe("a,1\n");
  });
});
