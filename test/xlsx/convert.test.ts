/**
 * The headline cross-format tests: converting between CSV and XLSX through
 * the core convert() pipeline - the `pandoc -f csv -t xlsx` equivalent.
 */

import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { contentToText, convert, text } from "../../src/core/index.js";
import * as Csv from "../../src/csv/index.js";
import * as Xlsx from "../../src/xlsx/index.js";

describe("convert: CSV <-> XLSX", () => {
  test("csv -> xlsx -> csv round-trips values", async () => {
    const csvText = "name,age,active\nalice,30,true\nbob,25.5,false\n";

    const program = Effect.gen(function* () {
      // CSV -> XLSX (header row carried over as a regular first row)
      const xlsxContent = yield* convert({
        from: Csv.format,
        to: Xlsx.format,
        input: text(csvText),
      });

      expect(xlsxContent._tag).toBe("Bytes");

      // XLSX -> CSV
      const backToCsv = yield* convert({
        from: Xlsx.format,
        to: Csv.format,
        input: xlsxContent,
      });

      return contentToText(backToCsv);
    });

    const result = await Effect.runPromise(program);
    expect(result).toBe(csvText);
  });

  test("csv -> xlsx with headers marked produces a header row in the sheet", async () => {
    const csvText = "name,age\nalice,30\n";

    const program = convert({
      from: Csv.makeFormat({ reader: { treatFirstRowAsHeader: true } }),
      to: Xlsx.format,
      input: text(csvText),
    }).pipe(
      Effect.flatMap((xlsxContent) =>
        // Read back marking the first row as headers
        convert({
          from: Xlsx.makeFormat({ reader: { firstRowAsHeader: true } }),
          to: Csv.format,
          input: xlsxContent,
        })
      ),
      Effect.map(contentToText)
    );

    const result = await Effect.runPromise(program);
    expect(result).toBe(csvText);
  });

  test("tsv -> xlsx conversion", async () => {
    const tsvText = "x\ty\n1\t2\n";

    const program = convert({
      from: Csv.tsvFormat,
      to: Xlsx.format,
      input: text(tsvText),
    }).pipe(
      Effect.flatMap((xlsxContent) =>
        convert({
          from: Xlsx.format,
          to: Csv.tsvFormat,
          input: xlsxContent,
        })
      ),
      Effect.map(contentToText)
    );

    const result = await Effect.runPromise(program);
    expect(result).toBe(tsvText);
  });

  test("type inference survives the conversion: numbers stay numbers", async () => {
    const program = Effect.gen(function* () {
      const xlsxContent = yield* convert({
        from: Csv.format,
        to: Xlsx.format,
        input: text("42,3.5,true,hello\n"),
      });

      // Inspect the workbook directly to verify cell types
      const workbook = yield* Xlsx.format.reader!.readWorkbook!(xlsxContent);
      return workbook.sheets[0]!.rows[0]!;
    });

    const row = await Effect.runPromise(program);
    expect(row[0]?._tag).toBe("CellNumber");
    expect(row[1]?._tag).toBe("CellNumber");
    expect(row[2]?._tag).toBe("CellBoolean");
    expect(row[3]?._tag).toBe("CellString");
  });

  test("fails with ConversionError when a format lacks the needed direction", async () => {
    const readOnlyFormat = { id: "readonly", reader: Csv.format.reader };

    const result = await Effect.runPromiseExit(
      convert({
        from: Csv.format,
        to: readOnlyFormat,
        input: text("a,b\n"),
      })
    );

    expect(result._tag).toBe("Failure");
  });
});
