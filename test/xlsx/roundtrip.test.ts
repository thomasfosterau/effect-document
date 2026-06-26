/**
 * XLSX round-trip tests: workbooks written by XlsxWriter are read back
 * identically by XlsxReader. Fixtures are generated in-test; no binary files
 * are checked in.
 */

import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import {
  cell,
  contentToBytes,
  sheet,
  workbookOf,
  type Workbook,
} from "../../src/core/index.js";
import {
  makeXlsxReader,
  makeXlsxWriter,
  type XlsxReaderOptions,
} from "../../src/xlsx/index.js";

const writeRead = (
  workbook: Workbook,
  readerOptions?: XlsxReaderOptions
): Promise<Workbook> =>
  Effect.runPromise(
    makeXlsxWriter()
      .writeWorkbook!(workbook)
      .pipe(
        Effect.flatMap((content) =>
          makeXlsxReader(readerOptions).readWorkbook!(content)
        )
      )
  );

describe("XLSX write -> read round-trip", () => {
  test("preserves typed cells", async () => {
    const original = workbookOf(
      sheet("Data", [
        [cell.str("hello"), cell.num(42), cell.bool(true)],
        [cell.str("world"), cell.num(-3.25), cell.bool(false)],
      ])
    );

    const result = await writeRead(original);

    expect(result.sheets.length).toBe(1);
    expect(result.sheets[0]!.name).toBe("Data");
    expect(result.sheets[0]!.rows).toEqual(original.sheets[0]!.rows);
  });

  test("preserves headers when reading with firstRowAsHeader", async () => {
    const original = workbookOf(
      sheet(
        "People",
        [
          [cell.str("alice"), cell.num(30)],
          [cell.str("bob"), cell.num(25)],
        ],
        ["name", "age"]
      )
    );

    const result = await writeRead(original, { firstRowAsHeader: true });

    expect(result.sheets[0]!.headers).toEqual(["name", "age"]);
    expect(result.sheets[0]!.rows).toEqual(original.sheets[0]!.rows);
  });

  test("preserves multiple sheets in order", async () => {
    const original = workbookOf(
      sheet("First", [[cell.str("a")]]),
      sheet("Second", [[cell.num(2)]]),
      sheet("Third", [[cell.bool(true)]])
    );

    const result = await writeRead(original);

    expect(result.sheets.map((s) => s.name)).toEqual([
      "First",
      "Second",
      "Third",
    ]);
    expect(result.sheets[0]!.rows[0]?.[0]?._tag).toBe("CellString");
    expect(result.sheets[1]!.rows[0]?.[0]?._tag).toBe("CellNumber");
    expect(result.sheets[2]!.rows[0]?.[0]?._tag).toBe("CellBoolean");
  });

  test("preserves empty cells as nulls in a dense grid", async () => {
    const original = workbookOf(
      sheet("Sparse", [
        [cell.str("a"), cell.empty(), cell.str("c")],
        [cell.empty(), cell.str("b"), cell.empty()],
      ])
    );

    const result = await writeRead(original);

    expect(result.sheets[0]!.rows).toEqual(original.sheets[0]!.rows);
  });

  test("dates round-trip as ISO strings (documented lossy behavior)", async () => {
    const original = workbookOf(
      sheet("Dates", [[cell.date(new Date("2024-06-15T12:00:00.000Z"))]])
    );

    const result = await writeRead(original);

    expect(result.sheets[0]!.rows[0]?.[0]).toEqual(
      cell.str("2024-06-15T12:00:00.000Z") as never
    );
  });

  test("preserves strings needing XML escaping", async () => {
    const original = workbookOf(
      sheet("Escapes", [
        [
          cell.str("a < b & c > d"),
          cell.str('quotes "inside"'),
          cell.str("tabs\tand\nnewlines"),
        ],
      ])
    );

    const result = await writeRead(original);

    expect(result.sheets[0]!.rows).toEqual(original.sheets[0]!.rows);
  });

  test("preserves sheet names needing escaping", async () => {
    const original = workbookOf(sheet("Q&A <2024>", [[cell.str("x")]]));

    const result = await writeRead(original);

    expect(result.sheets[0]!.name).toBe("Q&A <2024>");
  });

  test("deduplicates shared strings", async () => {
    const original = workbookOf(
      sheet("Dupes", [
        [cell.str("same"), cell.str("same"), cell.str("same")],
        [cell.str("same"), cell.str("different"), cell.str("same")],
      ])
    );

    const written = await Effect.runPromise(
      makeXlsxWriter().writeWorkbook!(original)
    );

    // The package should contain "same" only once in sharedStrings.xml
    const { unzipSync, strFromU8 } = await import("fflate");
    const files = unzipSync(contentToBytes(written));
    const sharedStrings = strFromU8(files["xl/sharedStrings.xml"]!);
    expect(sharedStrings.split("same").length - 1).toBe(1);

    // And still read back correctly
    const result = await writeRead(original);
    expect(result.sheets[0]!.rows).toEqual(original.sheets[0]!.rows);
  });

  test("produces a structurally valid OOXML package", async () => {
    const written = await Effect.runPromise(
      makeXlsxWriter().writeWorkbook!(
        workbookOf(sheet("Check", [[cell.str("x")]]))
      )
    );

    const { unzipSync } = await import("fflate");
    const files = unzipSync(contentToBytes(written));

    expect(Object.keys(files).sort()).toEqual([
      "[Content_Types].xml",
      "_rels/.rels",
      "xl/_rels/workbook.xml.rels",
      "xl/sharedStrings.xml",
      "xl/workbook.xml",
      "xl/worksheets/sheet1.xml",
    ]);
  });
});
