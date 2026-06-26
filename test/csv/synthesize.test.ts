/**
 * Tests for tabular data synthesis
 */

import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { synthesizeTable, synthesizeWorkbook } from "../../src/csv/index.js";

describe("synthesizeTable", () => {
  test("generates the requested shape", async () => {
    const result = await Effect.runPromise(
      synthesizeTable({ columns: 3, quantity: 5 })
    );

    expect(result.headers).toEqual(["col0", "col1", "col2"]);
    expect(result.rows.length).toBe(5);
    expect(result.rows[0]?.length).toBe(3);
  });

  test("is deterministic with a seed", async () => {
    const spec = { columns: 2, quantity: 3, seed: 12345 };
    const first = await Effect.runPromise(synthesizeTable(spec));
    const second = await Effect.runPromise(synthesizeTable(spec));

    expect(first.rows).toEqual(second.rows);
  });

  test("respects the field length range", async () => {
    const result = await Effect.runPromise(
      synthesizeTable({
        columns: 2,
        quantity: 10,
        fieldLengthRange: [3, 6],
        seed: 999,
      })
    );

    for (const row of result.rows) {
      for (const field of row) {
        expect(field.length).toBeGreaterThanOrEqual(3);
        expect(field.length).toBeLessThanOrEqual(6);
      }
    }
  });
});

describe("synthesizeWorkbook", () => {
  test("produces a single-sheet workbook of string cells", async () => {
    const workbook = await Effect.runPromise(
      synthesizeWorkbook({ columns: ["id", "name"], quantity: 4, seed: 7 })
    );

    expect(workbook.sheets.length).toBe(1);
    const sheet = workbook.sheets[0]!;
    expect(sheet.headers).toEqual(["id", "name"]);
    expect(sheet.rows.length).toBe(4);
    expect(sheet.rows[0]?.every((c) => c._tag === "CellString")).toBe(true);
  });

  test("supports custom sheet names", async () => {
    const workbook = await Effect.runPromise(
      synthesizeWorkbook({ columns: 1, quantity: 1, seed: 1 }, "Generated")
    );

    expect(workbook.sheets[0]!.name).toBe("Generated");
  });
});
