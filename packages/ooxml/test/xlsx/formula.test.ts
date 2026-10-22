import { describe, expect, test } from "vite-plus/test";
import { translateFormula } from "../../src/xlsx/formula.ts";

describe("translateFormula", () => {
  test("shifts relative parts and keeps $-anchored ones", () => {
    expect(translateFormula("A1+$A1+A$1+$A$1", 2, 1)).toBe("B3+$A3+B$1+$A$1");
  });

  test("shifts column and row ranges", () => {
    expect(translateFormula("SUM(A:$B)+SUM(1:$2)", 1, 1)).toBe("SUM(B:$B)+SUM(2:$2)");
  });

  test("leaves sheet names, function names, strings and quoted sheets alone", () => {
    expect(translateFormula(`Sheet1!A1+'My A1'!B2+LOG10(C3)+"D4"+Table1[Col]`, 1, 0)).toBe(
      `Sheet1!A2+'My A1'!B3+LOG10(C4)+"D4"+Table1[Col]`,
    );
  });

  test("a reference moved off the sheet becomes #REF!", () => {
    expect(translateFormula("A1+B2", -1, 0)).toBe("#REF!+B1");
  });

  test("names that look like references beyond XFD1048576 are not shifted", () => {
    expect(translateFormula("ABCD1+A2000000", 1, 1)).toBe("ABCD1+A2000000");
  });
});
