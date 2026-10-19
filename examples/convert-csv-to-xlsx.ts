/**
 * The headline effect-document workflow: converting between formats.
 *
 * CSV text goes in, a real .xlsx file comes out, and back again - and because
 * the formats carry their profiles, `convert` reports when a step is lossy.
 *
 * Run with: bun run examples/convert-csv-to-xlsx.ts
 */

import { Effect } from "effect";
import { contentToBytes, contentToText, convert, text } from "@thomasfosterau/effect-document";
import * as Csv from "@thomasfosterau/effect-document-csv";
import { Xlsx } from "@thomasfosterau/effect-document-ooxml";

const csvSource = `product,price,in_stock
Laptop,999.99,true
Mouse,24.99,true
Keyboard,79.5,false
Monitor,349,true
`;

const program = Effect.gen(function* () {
  console.log("=== Source CSV ===");
  console.log(csvSource);

  // --- CSV -> XLSX (a free widening: CSV's profile is a subset of XLSX's) ---
  const { content: xlsxContent, loss: toXlsxLoss } = yield* convert({
    from: Csv.makeFormat({ reader: { treatFirstRowAsHeader: true } }),
    to: Xlsx.format,
    input: text(csvSource),
  });

  const xlsxBytes = contentToBytes(xlsxContent);
  console.log(`=== Converted to XLSX: ${xlsxBytes.length} bytes (lossless: ${toXlsxLoss.isLossless}) ===`);
  yield* Effect.promise(() => Bun.write("output.xlsx", xlsxBytes as Uint8Array<ArrayBuffer>));
  console.log("Wrote output.xlsx\n");

  // --- XLSX -> CSV (a narrowing: anything CSV can't represent is reported) ---
  const { content: backToCsv, loss: toCsvLoss } = yield* convert({
    from: Xlsx.format,
    to: Csv.format,
    input: xlsxContent,
  });

  console.log("=== Converted back to CSV ===");
  console.log(contentToText(backToCsv));
  console.log("Loss report:", toCsvLoss.isLossless ? "(lossless)" : toCsvLoss.entries);

  // --- Inspect the typed worksheet ---------------------------------------
  const doc = yield* Xlsx.format.reader!.read(xlsxContent);
  const ws = doc.blocks.find((b) => b._tag === "Worksheet");
  console.log("\n=== Typed cells (numbers and booleans inferred) ===");
  if (ws?._tag === "Worksheet") {
    for (const row of ws.rows) {
      console.log(row.cells.map((c) => c._tag).join(", "));
    }
  }
});

Effect.runPromise(program);
