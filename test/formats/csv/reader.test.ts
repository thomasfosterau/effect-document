/**
 * Tests for the new CSV Reader (Workbook-producing API)
 */

import { describe, expect, test } from "bun:test";
import { Effect, Stream } from "effect";
import { text } from "../../../src/core/index.js";
import { TsvDialect, inferCell, makeCsvReader } from "../../../src/formats/csv/index.js";

describe("CSV Reader -> Workbook", () => {
  test("reads CSV into a single-sheet workbook with typed cells", async () => {
    const reader = makeCsvReader({ treatFirstRowAsHeader: true });
    const workbook = await Effect.runPromise(
      reader.readWorkbook!(text("name,age,active\nalice,30,true\nbob,25.5,false"))
    );

    expect(workbook.sheets.length).toBe(1);
    const sheet = workbook.sheets[0]!;
    expect(sheet.name).toBe("Sheet1");
    expect(sheet.headers).toEqual(["name", "age", "active"]);

    expect(sheet.rows[0]).toEqual([
      { _tag: "CellString", value: "alice" },
      { _tag: "CellNumber", value: 30 },
      { _tag: "CellBoolean", value: true },
    ] as never);
    expect(sheet.rows[1]?.[1]).toEqual({ _tag: "CellNumber", value: 25.5 } as never);
  });

  test("keeps everything as strings when inferTypes is false", async () => {
    const reader = makeCsvReader({
      treatFirstRowAsHeader: true,
      inferTypes: false,
    });
    const workbook = await Effect.runPromise(
      reader.readWorkbook!(text("a,b\n1,true"))
    );

    const row = workbook.sheets[0]!.rows[0]!;
    expect(row[0]?._tag).toBe("CellString");
    expect(row[1]?._tag).toBe("CellString");
  });

  test("empty fields become null cells when inferring types", async () => {
    const reader = makeCsvReader({ treatFirstRowAsHeader: true });
    const workbook = await Effect.runPromise(
      reader.readWorkbook!(text("a,b\nx,\n,y"))
    );

    const rows = workbook.sheets[0]!.rows;
    expect(rows[0]?.[1]?._tag).toBe("CellNull");
    expect(rows[1]?.[0]?._tag).toBe("CellNull");
  });

  test("supports custom dialects (TSV)", async () => {
    const reader = makeCsvReader({
      dialect: TsvDialect,
      treatFirstRowAsHeader: true,
    });
    const workbook = await Effect.runPromise(
      reader.readWorkbook!(text("a\tb\n1\t2"))
    );

    expect(workbook.sheets[0]!.headers).toEqual(["a", "b"]);
    expect(workbook.sheets[0]!.rows[0]?.length).toBe(2);
  });

  test("supports custom sheet names", async () => {
    const reader = makeCsvReader({ sheetName: "ImportedData" });
    const workbook = await Effect.runPromise(reader.readWorkbook!(text("a,b")));

    expect(workbook.sheets[0]!.name).toBe("ImportedData");
  });

  test("fails with ParseError on column count mismatch", async () => {
    const reader = makeCsvReader({ treatFirstRowAsHeader: true });

    await expect(
      Effect.runPromise(reader.readWorkbook!(text("a,b,c\n1,2")))
    ).rejects.toThrow();
  });
});

describe("CSV Reader -> row stream", () => {
  test("streams raw string rows", async () => {
    const reader = makeCsvReader({ treatFirstRowAsHeader: true });
    const rows = await Effect.runPromise(
      Stream.runCollect(reader.readRowStream!(text("a,b\n1,2\n3,4"))).pipe(
        Effect.map((chunk) => Array.from(chunk))
      )
    );

    expect(rows).toEqual([
      ["1", "2"],
      ["3", "4"],
    ]);
  });
});

describe("inferCell", () => {
  test("infers types from raw strings", () => {
    expect(inferCell("")._tag).toBe("CellNull");
    expect(inferCell("true")._tag).toBe("CellBoolean");
    expect(inferCell("false")._tag).toBe("CellBoolean");
    expect(inferCell("42")._tag).toBe("CellNumber");
    expect(inferCell("-3.5")._tag).toBe("CellNumber");
    expect(inferCell("1e10")._tag).toBe("CellNumber");
    expect(inferCell("hello")._tag).toBe("CellString");
    expect(inferCell("12abc")._tag).toBe("CellString");
    expect(inferCell("Infinity")._tag).toBe("CellString");
    expect(inferCell("NaN")._tag).toBe("CellString");
    // whitespace-only is not a number
    expect(inferCell("  ")._tag).toBe("CellString");
  });
});
