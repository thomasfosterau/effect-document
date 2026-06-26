/**
 * The headline effect-document workflow: converting between formats.
 *
 * This is the equivalent of `pandoc -f csv -t xlsx` - CSV text goes in,
 * a real .xlsx file comes out, and back again.
 *
 * Run with: bun run examples/convert-csv-to-xlsx.ts
 */

import { Effect } from "effect";
import { contentToBytes, contentToText, convert, text, Csv, Xlsx } from "@thomasfosterau/effect-document";

const csvSource = `product,price,in_stock
Laptop,999.99,true
Mouse,24.99,true
Keyboard,79.5,false
Monitor,349,true
`;

const program = Effect.gen(function* () {
  console.log("=== Source CSV ===");
  console.log(csvSource);

  // --- CSV -> XLSX -------------------------------------------------------
  const xlsxContent = yield* convert({
    from: Csv.makeFormat({ reader: { treatFirstRowAsHeader: true } }),
    to: Xlsx.format,
    input: text(csvSource),
  });

  const xlsxBytes = contentToBytes(xlsxContent);
  console.log(`=== Converted to XLSX: ${xlsxBytes.length} bytes ===`);

  // Write a real Excel file you can open
  yield* Effect.promise(() => Bun.write("output.xlsx", xlsxBytes as Uint8Array<ArrayBuffer>));
  console.log("Wrote output.xlsx\n");

  // --- XLSX -> CSV (round-trip) ------------------------------------------
  const backToCsv = yield* convert({
    from: Xlsx.makeFormat({ reader: { firstRowAsHeader: true } }),
    to: Csv.format,
    input: xlsxContent,
  });

  console.log("=== Converted back to CSV ===");
  console.log(contentToText(backToCsv));

  // --- Inspect the typed workbook -----------------------------------------
  const workbook = yield* Xlsx.format.reader!.readWorkbook!(xlsxContent);
  console.log("=== Typed cells (numbers and booleans inferred) ===");
  for (const row of workbook.sheets[0]!.rows) {
    console.log(row.map((cell) => `${cell._tag}`).join(", "));
  }
});

Effect.runPromise(program);
