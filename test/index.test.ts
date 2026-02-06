/**
 * Test suite for unified CSV operations
 */

import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { csvRead, csvWrite, csvSynthesize, type TableData } from "../src/index.js";

describe("CSV Read Operations", () => {
  test("should read basic CSV with headers", async () => {
    const input = "a,b,c\n1,2,3\n4,5,6";
    const result = await Effect.runPromise(
      csvRead(input, { treatFirstRowAsHeader: true })
    );

    expect(result.columnHeaders).toEqual(["a", "b", "c"]);
    expect(result.dataRows).toEqual([
      ["1", "2", "3"],
      ["4", "5", "6"],
    ]);
  });

  test("should read CSV without headers", async () => {
    const input = "1,2,3\n4,5,6";
    const result = await Effect.runPromise(csvRead(input));

    expect(result.columnHeaders).toBeNull();
    expect(result.dataRows).toEqual([
      ["1", "2", "3"],
      ["4", "5", "6"],
    ]);
  });

  test("should handle quoted fields with commas", async () => {
    const input = 'a,b\n"hello, world",test';
    const result = await Effect.runPromise(csvRead(input));

    expect(result.dataRows[1]).toEqual(["hello, world", "test"]);
  });

  test("should handle escaped quotes", async () => {
    const input = 'a,b\n"say ""hi""",test';
    const result = await Effect.runPromise(csvRead(input));

    expect(result.dataRows[1]).toEqual(['say "hi"', "test"]);
  });

  test("should trim whitespace when configured", async () => {
    const input = " a , b , c \n 1 , 2 , 3 ";
    const result = await Effect.runPromise(
      csvRead(input, {
        treatFirstRowAsHeader: true,
        trimWhitespace: true,
      })
    );

    expect(result.columnHeaders).toEqual(["a", "b", "c"]);
    expect(result.dataRows[0]).toEqual(["1", "2", "3"]);
  });

  test("should filter empty lines", async () => {
    const input = "a,b\n1,2\n\n3,4";
    const result = await Effect.runPromise(
      csvRead(input, {
        treatFirstRowAsHeader: true,
        filterEmpty: true,
      })
    );

    expect(result.dataRows.length).toBe(2);
    expect(result.dataRows).toEqual([
      ["1", "2"],
      ["3", "4"],
    ]);
  });

  test("should skip initial rows", async () => {
    const input = "comment\ncomment2\na,b\n1,2";
    const result = await Effect.runPromise(
      csvRead(input, {
        skipRows: 2,
        treatFirstRowAsHeader: true,
      })
    );

    expect(result.columnHeaders).toEqual(["a", "b"]);
    expect(result.dataRows).toEqual([["1", "2"]]);
  });

  test("should use provided headers", async () => {
    const input = "1,2,3\n4,5,6";
    const result = await Effect.runPromise(
      csvRead(input, {
        providedHeaders: ["x", "y", "z"],
      })
    );

    expect(result.columnHeaders).toEqual(["x", "y", "z"]);
  });
});

describe("CSV Write Operations", () => {
  test("should write basic table with headers", async () => {
    const table: TableData = {
      columnHeaders: ["a", "b"],
      dataRows: [
        ["1", "2"],
        ["3", "4"],
      ],
    };

    const result = await Effect.runPromise(csvWrite(table));
    expect(result).toBe("a,b\n1,2\n3,4\n");
  });

  test("should write table without headers", async () => {
    const table: TableData = {
      columnHeaders: null,
      dataRows: [
        ["1", "2"],
        ["3", "4"],
      ],
    };

    const result = await Effect.runPromise(csvWrite(table));
    expect(result).toBe("1,2\n3,4\n");
  });

  test("should quote fields containing commas", async () => {
    const table: TableData = {
      columnHeaders: null,
      dataRows: [["hello, world", "test"]],
    };

    const result = await Effect.runPromise(csvWrite(table));
    expect(result).toBe('"hello, world",test\n');
  });

  test("should escape quotes in fields", async () => {
    const table: TableData = {
      columnHeaders: null,
      dataRows: [['say "hi"', "test"]],
    };

    const result = await Effect.runPromise(csvWrite(table));
    expect(result).toBe('"say ""hi""",test\n');
  });

  test("should quote fields containing newlines", async () => {
    const table: TableData = {
      columnHeaders: null,
      dataRows: [["line1\nline2", "test"]],
    };

    const result = await Effect.runPromise(csvWrite(table));
    expect(result).toContain('"line1\nline2"');
  });
});

describe("CSV Synthesis", () => {
  test("should generate specified number of rows", async () => {
    const result = await Effect.runPromise(
      csvSynthesize({
        columns: 3,
        quantity: 5,
      })
    );

    expect(result.dataRows.length).toBe(5);
    expect(result.dataRows[0]?.length).toBe(3);
  });

  test("should use column names when provided", async () => {
    const result = await Effect.runPromise(
      csvSynthesize({
        columns: ["id", "name", "value"],
        quantity: 2,
      })
    );

    expect(result.columnHeaders).toEqual(["id", "name", "value"]);
    expect(result.dataRows.length).toBe(2);
  });

  test("should produce consistent results with seed", async () => {
    const result1 = await Effect.runPromise(
      csvSynthesize({
        columns: 2,
        quantity: 3,
        seed: 12345,
      })
    );

    const result2 = await Effect.runPromise(
      csvSynthesize({
        columns: 2,
        quantity: 3,
        seed: 12345,
      })
    );

    expect(result1.dataRows).toEqual(result2.dataRows);
  });

  test("should respect field length range", async () => {
    const result = await Effect.runPromise(
      csvSynthesize({
        columns: 2,
        quantity: 10,
        fieldLengthRange: [5, 10],
        seed: 999,
      })
    );

    result.dataRows.forEach((row) => {
      row.forEach((field) => {
        expect(field.length).toBeGreaterThanOrEqual(5);
        expect(field.length).toBeLessThanOrEqual(10);
      });
    });
  });
});

describe("Round-trip Operations", () => {
  test("should maintain data through read-write cycle", async () => {
    const original: TableData = {
      columnHeaders: ["x", "y"],
      dataRows: [
        ["a", "b"],
        ["c", "d"],
      ],
    };

    const csv = await Effect.runPromise(csvWrite(original));
    const parsed = await Effect.runPromise(
      csvRead(csv, { treatFirstRowAsHeader: true })
    );

    expect(parsed.columnHeaders).toEqual(original.columnHeaders);
    expect(parsed.dataRows).toEqual(original.dataRows);
  });
});
