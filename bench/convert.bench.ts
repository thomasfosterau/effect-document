/**
 * `convert` between formats: read, narrow to the target's profile, write.
 * CSV ↔ XLSX is measured against maintained libraries doing the same: Papa
 * Parse (typing values) into write-excel-file, and read-excel-file into Papa
 * Parse's `unparse` (no maintained library converts between them on its own:
 * SheetJS, which does, has not been updated on npm since 2022). DOCX → RTF
 * and DOCX → PDF on their own, as no other JavaScript library converts
 * between them.
 *
 * Run with `vp run bench:convert` (builds first).
 */
import * as Csv from "@thomasfosterau/effect-csv";
import { bytes, contentToBytes, convert, narrow, text } from "@thomasfosterau/effect-document";
import { Docx, Xlsx } from "@thomasfosterau/effect-ooxml";
import * as Pdf from "@thomasfosterau/effect-pdf";
import * as Rtf from "@thomasfosterau/effect-rtf";
import * as Effect from "effect/Effect";
import Papa from "papaparse";
import { Buffer } from "node:buffer";
import { readSheet } from "read-excel-file/node";
import writeXlsxFile from "write-excel-file/node";
import { type Group, rng, runGroups } from "./harness.ts";
import { proseDocument } from "./prose.ts";

const run = <A, E>(effect: Effect.Effect<A, E>): A => Effect.runSync(effect);

const random = rng(2026);
const csv =
  ["id,name,price,active"]
    .concat(
      Array.from(
        { length: 20_000 },
        (_, i) => `${i},item ${i},${(random() * 1000).toFixed(2)},${random() < 0.5}`,
      ),
    )
    .join("\n") + "\n";
const xlsx = contentToBytes(
  run(convert({ from: Csv.format, to: Xlsx.format, input: text(csv) })).content,
);
const docx = contentToBytes(
  run(Docx.makeDocxWriter().write(narrow(proseDocument(100), Docx.Docx).document)),
);
const size = (s: string) => new TextEncoder().encode(s).length;

const groups: Array<Group> = [
  {
    name: "CSV → XLSX: 20k rows",
    bytes: size(csv),
    cases: [
      {
        name: "effect-document convert",
        run: () => run(convert({ from: Csv.format, to: Xlsx.format, input: text(csv) })),
      },
      {
        name: "Papa Parse + write-excel-file",
        run: () =>
          writeXlsxFile(
            Papa.parse<Array<string | number | boolean>>(csv, {
              dynamicTyping: true,
              skipEmptyLines: true,
            }).data,
          ).toBuffer(),
      },
    ],
  },
  {
    name: "XLSX → CSV: 20k rows",
    bytes: xlsx.length,
    cases: [
      {
        name: "effect-document convert",
        run: () => run(convert({ from: Xlsx.format, to: Csv.format, input: bytes(xlsx) })),
      },
      {
        name: "read-excel-file + Papa Parse unparse",
        run: async () => Papa.unparse(await readSheet(Buffer.from(xlsx))),
      },
    ],
  },
  {
    name: "DOCX → RTF: 100 sections",
    bytes: docx.length,
    cases: [
      {
        name: "effect-document convert",
        run: () => run(convert({ from: Docx.format, to: Rtf.format, input: bytes(docx) })),
      },
    ],
  },
  {
    name: "DOCX → PDF: 100 sections",
    bytes: docx.length,
    cases: [
      {
        name: "effect-document convert",
        run: () => run(convert({ from: Docx.format, to: Pdf.format, input: bytes(docx) })),
      },
    ],
  },
];

await runGroups("convert", groups);
