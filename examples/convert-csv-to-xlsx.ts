/**
 * The headline effect-document workflow: converting between formats.
 *
 * CSV text goes in, a real .xlsx file comes out, and back again - and because
 * the formats carry their profiles, `convert` reports when a step is lossy.
 *
 * Run with: vp exec tsx examples/convert-csv-to-xlsx.ts
 */

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Arr from "effect/Array";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Predicate from "effect/Predicate";
import {
  type Block,
  type Worksheet,
  contentToBytes,
  contentToText,
  convert,
  text,
} from "@thomasfosterau/effect-document";
import * as Csv from "@thomasfosterau/effect-csv";
import { Xlsx } from "@thomasfosterau/effect-ooxml";

const csvSource = `product,price,in_stock
Laptop,999.99,true
Mouse,24.99,true
Keyboard,79.5,false
Monitor,349,true
`;

const isWorksheet = (block: Block): block is Worksheet => Predicate.isTagged(block, "Worksheet");

const program = Effect.fn("convert-csv-to-xlsx")(function* () {
  const fs = yield* FileSystem.FileSystem;
  yield* Console.log("=== Source CSV ===");
  yield* Console.log(csvSource);

  // --- CSV -> XLSX (a free widening: CSV's profile is a subset of XLSX's) ---
  const { content: xlsxContent, loss: toXlsxLoss } = yield* convert({
    from: Csv.format, // the first row is the header by default
    to: Xlsx.format,
    input: text(csvSource),
  });

  const xlsxBytes = contentToBytes(xlsxContent);
  yield* Console.log(
    `=== Converted to XLSX: ${xlsxBytes.length} bytes (lossless: ${toXlsxLoss.isLossless}) ===`,
  );
  yield* fs.writeFile("output.xlsx", xlsxBytes);
  yield* Console.log("Wrote output.xlsx\n");

  // --- XLSX -> CSV (a narrowing: anything CSV can't represent is reported) ---
  const { content: backToCsv, loss: toCsvLoss } = yield* convert({
    from: Xlsx.format,
    to: Csv.format,
    input: xlsxContent,
  });

  yield* Console.log("=== Converted back to CSV ===");
  yield* Console.log(contentToText(backToCsv));
  yield* Console.log("Loss report:", toCsvLoss.isLossless ? "(lossless)" : toCsvLoss.entries);

  // --- Inspect the typed worksheet ---------------------------------------
  const doc = yield* Xlsx.makeXlsxReader().read(xlsxContent);
  const rows = doc.blocks.filter(isWorksheet).flatMap((ws) => ws.rows);
  yield* Console.log("\n=== Typed cells (numbers and booleans inferred) ===");
  yield* Effect.forEach(rows, (row) => Console.log(Arr.map(row.cells, (c) => c._tag).join(", ")), {
    concurrency: 1,
  });
});

Effect.runPromise(program().pipe(Effect.provide(NodeServices.layer)));
