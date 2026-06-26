/**
 * Tests for the tabular IR layer (Workbook / Sheet / Cell)
 */

import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import {
  CellBoolean,
  CellNull,
  CellNumber,
  CellString,
  Workbook,
  cell,
  cellToString,
  sheet,
  workbookOf,
} from "../../src/core/index.js";

describe("Cell constructors", () => {
  test("cell.str creates a string cell", () => {
    const c = cell.str("hello");
    expect(c._tag).toBe("CellString");
    expect(c.value).toBe("hello");
  });

  test("cell.num creates a numeric cell", () => {
    const c = cell.num(42.5);
    expect(c._tag).toBe("CellNumber");
    expect(c.value).toBe(42.5);
  });

  test("cell.bool creates a boolean cell", () => {
    const c = cell.bool(true);
    expect(c._tag).toBe("CellBoolean");
    expect(c.value).toBe(true);
  });

  test("cell.date creates a date cell", () => {
    const d = new Date("2024-06-15T00:00:00.000Z");
    const c = cell.date(d);
    expect(c._tag).toBe("CellDate");
    expect(c.value).toEqual(d);
  });

  test("cell.empty creates a null cell", () => {
    const c = cell.empty();
    expect(c._tag).toBe("CellNull");
  });
});

describe("cellToString", () => {
  test("renders all cell types canonically", () => {
    expect(cellToString(cell.str("abc"))).toBe("abc");
    expect(cellToString(cell.num(3.14))).toBe("3.14");
    expect(cellToString(cell.bool(true))).toBe("true");
    expect(cellToString(cell.bool(false))).toBe("false");
    expect(
      cellToString(cell.date(new Date("2024-06-15T12:30:00.000Z")))
    ).toBe("2024-06-15T12:30:00.000Z");
    expect(cellToString(cell.empty())).toBe("");
  });
});

describe("Sheet & Workbook", () => {
  test("sheet helper builds a named sheet with headers", () => {
    const s = sheet(
      "People",
      [
        [cell.str("alice"), cell.num(30)],
        [cell.str("bob"), cell.num(25)],
      ],
      ["name", "age"]
    );

    expect(s.name).toBe("People");
    expect(s.headers).toEqual(["name", "age"]);
    expect(s.rows.length).toBe(2);
  });

  test("workbookOf builds a workbook from sheets", () => {
    const wb = workbookOf(sheet("A", []), sheet("B", []));
    expect(wb.sheets.length).toBe(2);
    expect(wb.sheets.map((s) => s.name)).toEqual(["A", "B"]);
  });
});

describe("Schema serialization", () => {
  test("workbook round-trips through JSON encoding", () => {
    const original = workbookOf(
      sheet(
        "Data",
        [
          [cell.str("x"), cell.num(1), cell.bool(true), cell.empty()],
          [
            cell.str("y"),
            cell.num(-2.5),
            cell.bool(false),
            cell.date(new Date("2024-01-01T00:00:00.000Z")),
          ],
        ],
        ["text", "number", "flag", "extra"]
      )
    );

    const encoded = Schema.encodeSync(Workbook)(original);
    const json = JSON.parse(JSON.stringify(encoded));
    const decoded = Schema.decodeUnknownSync(Workbook)(json);

    expect(decoded.sheets.length).toBe(1);
    expect(decoded.sheets[0]?.headers).toEqual(["text", "number", "flag", "extra"]);
    expect(decoded.sheets[0]?.rows).toEqual(original.sheets[0]!.rows);
  });

  test("decoding rejects malformed cells", () => {
    const malformed = {
      sheets: [
        {
          name: "Bad",
          headers: null,
          rows: [[{ _tag: "CellNumber", value: "not a number" }]],
        },
      ],
    };

    expect(() => Schema.decodeUnknownSync(Workbook)(malformed)).toThrow();
  });

  test("typed cells preserve their types through decode", () => {
    const encoded = Schema.encodeSync(Workbook)(
      workbookOf(sheet("S", [[cell.num(99), cell.bool(true), cell.str("ok"), cell.empty()]]))
    );
    const decoded = Schema.decodeUnknownSync(Workbook)(encoded);
    const row = decoded.sheets[0]!.rows[0]!;

    expect(row[0]).toBeInstanceOf(CellNumber);
    expect(row[1]).toBeInstanceOf(CellBoolean);
    expect(row[2]).toBeInstanceOf(CellString);
    expect(row[3]).toBeInstanceOf(CellNull);
  });
});
