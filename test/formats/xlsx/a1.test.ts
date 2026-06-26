/**
 * Tests for A1-notation coordinate helpers
 */

import { describe, expect, test } from "bun:test";
import { colToIndex, indexToCol, parseA1, toA1 } from "../../../src/formats/xlsx/index.js";

describe("indexToCol / colToIndex", () => {
  test("converts single-letter columns", () => {
    expect(indexToCol(0)).toBe("A");
    expect(indexToCol(1)).toBe("B");
    expect(indexToCol(25)).toBe("Z");
    expect(colToIndex("A")).toBe(0);
    expect(colToIndex("Z")).toBe(25);
  });

  test("converts multi-letter columns", () => {
    expect(indexToCol(26)).toBe("AA");
    expect(indexToCol(27)).toBe("AB");
    expect(indexToCol(51)).toBe("AZ");
    expect(indexToCol(52)).toBe("BA");
    expect(indexToCol(701)).toBe("ZZ");
    expect(indexToCol(702)).toBe("AAA");
    expect(colToIndex("AA")).toBe(26);
    expect(colToIndex("ZZ")).toBe(701);
    expect(colToIndex("AAA")).toBe(702);
  });

  test("round-trips all columns up to ZZZ", () => {
    for (let i = 0; i < 18278; i++) {
      expect(colToIndex(indexToCol(i))).toBe(i);
    }
  });
});

describe("toA1 / parseA1", () => {
  test("renders cell references", () => {
    expect(toA1(0, 0)).toBe("A1");
    expect(toA1(1, 2)).toBe("B3");
    expect(toA1(26, 99)).toBe("AA100");
  });

  test("parses cell references", () => {
    expect(parseA1("A1")).toEqual({ col: 0, row: 0 });
    expect(parseA1("B3")).toEqual({ col: 1, row: 2 });
    expect(parseA1("AA100")).toEqual({ col: 26, row: 99 });
  });

  test("returns null for invalid references", () => {
    expect(parseA1("")).toBeNull();
    expect(parseA1("123")).toBeNull();
    expect(parseA1("ABC")).toBeNull();
    expect(parseA1("a1")).toBeNull();
    expect(parseA1("A1B2")).toBeNull();
  });

  test("round-trips coordinates", () => {
    for (const [col, row] of [
      [0, 0],
      [5, 10],
      [26, 0],
      [100, 1000],
      [702, 1048575],
    ] as const) {
      expect(parseA1(toA1(col, row))).toEqual({ col, row });
    }
  });
});
