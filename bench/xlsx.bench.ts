/**
 * The XLSX reader and writer against ExcelJS (the most used actively
 * maintained workbook library) and read-excel-file / write-excel-file (the
 * leading maintained reader and writer of plain sheets), on one sheet of
 * mixed cells. SheetJS (`xlsx`) is left out: its npm release has not been
 * updated since 2022 (newer builds ship from its own CDN only), and the
 * benchmarks compare against maintained libraries only.
 *
 * - **read**: workbook bytes to cells (`makeXlsxReader().read`, against
 *   ExcelJS's `xlsx.load` and read-excel-file's `readSheet`). Every library
 *   reads the same file, written by our writer.
 * - **write**: cells to workbook bytes (`makeXlsxWriter().write` from a
 *   document, against ExcelJS's `xlsx.writeBuffer` from a worksheet and
 *   write-excel-file from an array of rows).
 * - **reference sheet** (#141): the reader alone on 27,500 rows, a
 *   7.8 MB worksheet part (the size the XML parser is held to), as written
 *   and with one formula cell, which sends the part down the tree path (the
 *   XML parser) instead of the `sheetData` row scanner.
 *
 * Run with `vp run bench:xlsx` (builds first).
 */
import {
  bytes,
  CellFormula,
  cell,
  contentToBytes,
  document,
  type SheetCell,
  trustAs,
  worksheet,
} from "@thomasfosterau/effect-document";
import { Xlsx } from "@thomasfosterau/effect-document/ooxml";
import ExcelJS from "exceljs";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import { Buffer } from "node:buffer";
import { readSheet } from "read-excel-file/node";
import writeXlsxFile from "write-excel-file/node";
import { type Group, rng, runGroups } from "./harness.ts";

const random = rng(2026);
const words = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta", "theta"];
const word = () => words[Math.floor(random() * words.length)] ?? "";

/** `rows` rows of eight columns: integers, decimals, text and booleans. */
const table = (rows: number): Array<Array<string | number | boolean>> =>
  Array.from({ length: rows }, (_, i) => [
    i,
    `${word()} ${word()}`,
    `${word()}.${i}@example.com`,
    Math.round(random() * 100000) / 100,
    Math.floor(random() * 100),
    `${word()}, ${word()} ${word()}`,
    random() < 0.5,
    random() * 1e6,
  ]);

const toCell = (v: string | number | boolean): SheetCell =>
  Predicate.isNumber(v) ? cell.number(v) : Predicate.isBoolean(v) ? cell.boolean(v) : cell.text(v);

const run = <A, E>(effect: Effect.Effect<A, E>): A => Effect.runSync(effect);
const reader = Xlsx.makeXlsxReader();
const writer = Xlsx.makeXlsxWriter();

const groups = (name: string, rows: number): Array<Group> => {
  const data = table(rows);
  const doc = trustAs<Xlsx.XlsxFeature>(
    document([
      worksheet(
        "Sheet1",
        data.map((r) => r.map(toCell)),
      ),
    ]),
  );
  const written = run(writer.write(doc));
  const file = contentToBytes(written);
  const buffer = Buffer.from(file);
  const exceljsBook = () => {
    const book = new ExcelJS.Workbook();
    book.addWorksheet("Sheet1").addRows(data);
    return book;
  };
  return [
    {
      name: `read: ${name}`,
      bytes: file.length,
      cases: [
        { name: "effect-document read", run: () => run(reader.read(bytes(file))) },
        {
          name: "ExcelJS xlsx.load",
          run: () => new ExcelJS.Workbook().xlsx.load(file.slice().buffer),
        },
        { name: "read-excel-file readSheet", run: () => readSheet(buffer) },
      ],
    },
    {
      name: `write: ${name}`,
      bytes: file.length,
      cases: [
        { name: "effect-document write (document)", run: () => run(writer.write(doc)) },
        { name: "ExcelJS writeBuffer (rows)", run: () => exceljsBook().xlsx.writeBuffer() },
        { name: "write-excel-file (rows)", run: () => writeXlsxFile(data).toBuffer() },
      ],
    },
  ];
};

/** The reader alone on one sheet of `cells`. */
const readGroup = (name: string, cells: ReadonlyArray<ReadonlyArray<SheetCell>>): Group => {
  const file = contentToBytes(
    run(writer.write(trustAs<Xlsx.XlsxFeature>(document([worksheet("Sheet1", cells)])))),
  );
  return {
    name,
    bytes: file.length,
    cases: [{ name: "effect-document read", run: () => run(reader.read(bytes(file))) }],
  };
};

/** The reader on the reference sheet, through the row scanner and through the tree path. */
const referenceGroups = (rows: number): Array<Group> => {
  const cells = table(rows).map((r) => r.map(toCell));
  // one formula in the last row: the row scanner gives the part to the tree path
  const withFormula = [...cells.slice(0, -1), [new CellFormula({ formula: "1+1", result: "2" })]];
  return [
    readGroup(`reference sheet: ${rows} rows, row scanner`, cells),
    readGroup(`reference sheet: ${rows} rows, tree path (one formula)`, withFormula),
  ];
};

await runGroups("XLSX", [
  ...referenceGroups(27_500),
  ...groups("20k rows × 8 columns", 20_000),
  ...groups("500 rows × 8 columns", 500),
]);
