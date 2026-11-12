/**
 * The `sheetData` scanner against the tree path: on every sheet the scanner
 * reads, its rows must be the rows the tree path reads from the parsed part.
 */

import { assert, describe, expect, test } from "vite-plus/test";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Struct from "effect/Struct";
import * as Result from "effect/Result";
import {
  findChild,
  parseWithScannedContent,
  parseXmlResult,
} from "../../../src/ooxml/shared/xml.ts";
import { parseWorksheetRows } from "../../../src/ooxml/xlsx/rows.ts";
import { scanSheetData } from "../../../src/ooxml/xlsx/sheetData.ts";

const SHARED = ["zero", "one", "two & three", "_x0041_"];

/** The rows the scanner reads, or none where it leaves the part to the tree path (as the reader does). */
const scanned = (xml: string, maxCells: number) =>
  Option.map(
    Option.filter(
      parseWithScannedContent(xml, "sheetData", (text, from) =>
        scanSheetData(text, from, SHARED, maxCells),
      ),
      ({ root, target }) => findChild(root, "sheetData") === target,
    ),
    // the rows alone: whether a row had a `customHeight` is the scanner's own note (#66)
    ({ value }) => Struct.omit(value, ["rowProps"]),
  );

/** The rows the tree path reads, or the parser's failure. */
const tree = (xml: string, maxCells: number) => {
  const root = parseXmlResult(xml);
  return Result.isSuccess(root)
    ? parseWorksheetRows(root.success, SHARED, maxCells)
    : { _tag: "Failed" as const };
};

const NS = `xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"`;

/** A worksheet of one row holding `cells`. */
const sheetOf = (cells: string) =>
  `<worksheet ${NS}><sheetData><row r="1">${cells}</row></sheetData></worksheet>`;

describe("the sheetData scanner", () => {
  // a Lehmer generator, so the inputs are the same on every run
  let seed = 7;
  const next = (n: number) => {
    seed = (seed * 48271) % 2147483647;
    return seed % n;
  };
  const pick = <A>(xs: Arr.NonEmptyReadonlyArray<A>): A =>
    Option.getOrElse(Arr.get(xs, next(xs.length)), () => xs[0]);
  const ref = () =>
    pick(["A", "B", "C", "AA", "a", "", "$A", "XFD", "ABCDE"]) +
    pick(["1", "2", "3", "01", "0", "", "x", "12345678901234567"]);
  const refAttr = () => (next(4) === 0 ? "" : ` r="${ref()}"`);
  // cells the scanner reads, and cells it must leave to the tree path
  const plain: Arr.NonEmptyReadonlyArray<() => string> = [
    () =>
      `<c${refAttr()} t="s"><v>${pick(["0", "1", "2", "3", "4", "", " 1", "1.5", "&#49;", "99999999999999999"])}</v></c>`,
    () =>
      `<c${refAttr()}><v>${pick(["1.5", "-2e3", "0", " ", "", "abc", "0x1F", "Infinity", "&#49;2", " 7 "])}</v></c>`,
    () =>
      `<c${refAttr()} t="${pick(["n", "b", "e", "str", "d", "x", "inlineStr", "s"])}"><v>${pick(["1", "0", " 1 ", "#N/A", "2024-01-02", "nope", "_x0042_"])}</v></c>`,
    () =>
      `<c${refAttr()} t="inlineStr"><is>${pick(["<t>a &amp; b</t>", "<t>x</t><t>y</t>", "<t/>", "", "<t>_x0041_</t>"])}</is></c>`,
    () => `<c${refAttr()} s="2"/>`,
    () => `<c${refAttr()} s="1" t="s"></c>`,
    () => `<c${refAttr()}  t='s' ><v/></c>`,
    () => `\n  `,
  ];
  const odd: Arr.NonEmptyReadonlyArray<string> = [
    `<c r="E1" t="str"><f>SUM(A1:B1)</f><v>3</v></c>`,
    `<c r="A2"><v><![CDATA[x]]></v></c>`,
    `<c r="A3" t="inlineStr"><is><r><t>rich</t></r></is></c>`,
    `<c r="A3" t="inlineStr"><is><t xml:space="preserve"> a </t></is></c>`,
    `<c r="A4" x:id="1"/>`,
    `<c r="A6" r="A7"/>`,
    `<c r="A8" s="1" s="2"/>`,
    `<c r="A&#49;"><v>1</v></c>`,
    `<c r="A9"><v>1</v><v>2</v></c>`,
    `<c r="A10"><extLst/></c>`,
    `<c r="A11"><v>1</c>`,
    `<!-- a comment -->`,
    `<x r="A1"/>`,
  ];
  const row = (oddOnes: boolean) =>
    `<row${pick(["", ` r="${1 + next(9)}"`, ` r="${1 + next(9)}" spans="1:3"`, ` r="x"`, ` r=" 3"`])}>` +
    Array.from({ length: next(6) }, () =>
      oddOnes && next(8) === 0 ? pick(odd) : pick(plain)(),
    ).join("") +
    `</row>`;
  const sheet = (oddOnes: boolean) =>
    `<?xml version="1.0"?><worksheet ${NS}><dimension ref="A1"/><sheetData>` +
    Array.from({ length: next(5) }, () =>
      next(10) === 0 ? `<row r="${1 + next(9)}"/>` : row(oddOnes),
    ).join(pick(["", "\n"])) +
    `</sheetData>${next(3) === 0 ? "<mergeCells/>" : ""}</worksheet>`;

  test("reads the rows the tree path reads, on every sheet it reads", () => {
    const inputs = [
      ...Array.from({ length: 3000 }, () => sheet(false)),
      ...Array.from({ length: 3000 }, () => sheet(true)),
      `<worksheet ${NS}><sheetData/></worksheet>`,
      `<worksheet ${NS}><sheetData></sheetData></worksheet>`,
      // sheetData that is not the root's: the tree path reads none of it
      `<worksheet ${NS}><x><sheetData><row><c><v>1</v></c></row></sheetData></x></worksheet>`,
      `<worksheet ${NS}><sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData><extra/>`,
    ];
    // compared one input at a time, so a failure names it and memory stays bounded
    const read = Arr.filter(inputs, (xml) => {
      const maxCells = next(4) === 0 ? next(8) : 20_000;
      const rows = scanned(xml, maxCells);
      Option.map(rows, (value) =>
        assert.deepEqual({ xml, rows: value }, { xml, rows: tree(xml, maxCells) }),
      );
      return Option.isSome(rows);
    });
    // the scanner reads most of the plain sheets, so the comparison is not vacuous
    expect(read.length).toBeGreaterThan(3000);
  });

  test("leaves a sheet over its budget, and markup it does not read, to the tree path", () => {
    expect(Option.isSome(scanned(sheetOf(`<c r="A1"><v>1</v></c>`), 10))).toBe(true);
    expect(Option.isNone(scanned(sheetOf(`<c r="C1"><v>1</v></c>`), 2))).toBe(true);
    expect(Option.isNone(scanned(sheetOf(`<c r="A1"><f>1+1</f><v>2</v></c>`), 10))).toBe(true);
    expect(Option.isNone(scanned(`<!-- x -->${sheetOf("")}`, 10))).toBe(true);
  });
});
