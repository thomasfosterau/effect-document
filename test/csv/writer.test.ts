/**
 * Tests for the new CSV Writer (Workbook-consuming API)
 */

import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { cell, contentToText, sheet, workbookOf } from "../../src/core/index.js";
import { TsvDialect, makeCsvWriter } from "../../src/csv/index.js";

describe("CSV Writer", () => {
  test("writes a workbook with typed cells canonically", async () => {
    const workbook = workbookOf(
      sheet(
        "Data",
        [
          [cell.str("alice"), cell.num(30), cell.bool(true), cell.empty()],
          [cell.str("bob"), cell.num(25.5), cell.bool(false), cell.str("x")],
        ],
        ["name", "age", "active", "extra"]
      )
    );

    const writer = makeCsvWriter();
    const output = await Effect.runPromise(writer.writeWorkbook!(workbook));

    expect(contentToText(output)).toBe(
      "name,age,active,extra\nalice,30,true,\nbob,25.5,false,x\n"
    );
  });

  test("quotes fields containing separators, quotes, and newlines", async () => {
    const workbook = workbookOf(
      sheet("Data", [
        [cell.str("hello, world"), cell.str('say "hi"'), cell.str("line1\nline2")],
      ])
    );

    const writer = makeCsvWriter();
    const output = await Effect.runPromise(writer.writeWorkbook!(workbook));

    expect(contentToText(output)).toBe(
      '"hello, world","say ""hi""","line1\nline2"\n'
    );
  });

  test("renders dates as ISO-8601 strings", async () => {
    const workbook = workbookOf(
      sheet("Data", [[cell.date(new Date("2024-06-15T00:00:00.000Z"))]])
    );

    const writer = makeCsvWriter();
    const output = await Effect.runPromise(writer.writeWorkbook!(workbook));

    expect(contentToText(output)).toBe("2024-06-15T00:00:00.000Z\n");
  });

  test("fails on multi-sheet workbooks by default", async () => {
    const workbook = workbookOf(sheet("One", []), sheet("Two", []));
    const writer = makeCsvWriter();

    await expect(
      Effect.runPromise(writer.writeWorkbook!(workbook))
    ).rejects.toThrow();
  });

  test("writes only the first sheet when onMultipleSheets is 'firstOnly'", async () => {
    const workbook = workbookOf(
      sheet("One", [[cell.str("first")]]),
      sheet("Two", [[cell.str("second")]])
    );
    const writer = makeCsvWriter({ onMultipleSheets: "firstOnly" });
    const output = await Effect.runPromise(writer.writeWorkbook!(workbook));

    expect(contentToText(output)).toBe("first\n");
  });

  test("supports custom dialects (TSV)", async () => {
    const workbook = workbookOf(
      sheet("Data", [[cell.str("a"), cell.str("b")]], ["x", "y"])
    );
    const writer = makeCsvWriter({ dialect: TsvDialect });
    const output = await Effect.runPromise(writer.writeWorkbook!(workbook));

    expect(contentToText(output)).toBe("x\ty\na\tb\n");
  });
});

describe("CSV Reader/Writer round-trip", () => {
  test("workbook -> CSV -> workbook preserves typed values", async () => {
    const { makeCsvReader } = await import("../../src/csv/index.js");

    const original = workbookOf(
      sheet(
        "Data",
        [
          [cell.str("alice"), cell.num(30), cell.bool(true)],
          [cell.str("bob"), cell.num(25.5), cell.bool(false)],
        ],
        ["name", "age", "active"]
      )
    );

    const writer = makeCsvWriter();
    const reader = makeCsvReader({
      treatFirstRowAsHeader: true,
      sheetName: "Data",
    });

    const roundTripped = await Effect.runPromise(
      writer.writeWorkbook!(original).pipe(
        Effect.flatMap((content) => reader.readWorkbook!(content))
      )
    );

    expect(roundTripped.sheets[0]!.headers).toEqual(["name", "age", "active"]);
    expect(roundTripped.sheets[0]!.rows).toEqual(original.sheets[0]!.rows);
  });
});
