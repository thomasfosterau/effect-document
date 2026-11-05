/**
 * The XLSX reader and writer against SheetJS (`xlsx`) and ExcelJS, the two
 * most used JavaScript workbook libraries, on one sheet of mixed cells.
 *
 * - **read**: workbook bytes to cells (`makeXlsxReader().read`, against
 *   `XLSX.read` and ExcelJS's `xlsx.load`). Every library reads the same
 *   file, written by our writer.
 * - **write**: cells to workbook bytes (`makeXlsxWriter().write` from a
 *   document, against `XLSX.write` from an array of rows and ExcelJS's
 *   `xlsx.writeBuffer` from a worksheet).
 *
 * Run with `vp run bench:xlsx` (builds first).
 */
import {
  bytes,
  cell,
  contentToBytes,
  document,
  type SheetCell,
  trustAs,
  worksheet,
} from "@thomasfosterau/effect-document";
import { Xlsx } from "@thomasfosterau/effect-ooxml";
import ExcelJS from "exceljs";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as XLSX from "xlsx";
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
  const sheetjsBook = () => {
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(data), "Sheet1");
    return book;
  };
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
        { name: "effect-ooxml read", run: () => run(reader.read(bytes(file))) },
        { name: "SheetJS XLSX.read", run: () => XLSX.read(file, { type: "array", dense: true }) },
        {
          name: "ExcelJS xlsx.load",
          run: () => new ExcelJS.Workbook().xlsx.load(file.slice().buffer),
        },
      ],
    },
    {
      name: `write: ${name}`,
      bytes: file.length,
      cases: [
        { name: "effect-ooxml write (document)", run: () => run(writer.write(doc)) },
        {
          name: "SheetJS XLSX.write (rows)",
          run: () =>
            XLSX.write(sheetjsBook(), { type: "array", bookType: "xlsx", compression: true }),
        },
        { name: "ExcelJS writeBuffer (rows)", run: () => exceljsBook().xlsx.writeBuffer() },
      ],
    },
  ];
};

await runGroups("XLSX", [
  ...groups("20k rows × 8 columns", 20_000),
  ...groups("500 rows × 8 columns", 500),
]);
