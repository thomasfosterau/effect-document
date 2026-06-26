/**
 * Streaming CSV rows with Effect Streams - process large inputs without
 * materializing the whole table, and synthesize test data to stream.
 *
 * Run with: bun run examples/streaming.ts
 */

import { Effect, Stream, pipe } from "effect";
import { contentToText, text } from "@thomasfosterau/effect-document";
import { makeCsvReader, makeCsvWriter, synthesizeWorkbook } from "@thomasfosterau/effect-document/csv";

const program = Effect.gen(function* () {
  // --- Synthesize a big CSV to play with ----------------------------------
  const workbook = yield* synthesizeWorkbook({
    columns: ["id", "name", "email"],
    quantity: 10_000,
    seed: 42,
  });

  const csvContent = yield* makeCsvWriter().writeWorkbook!(workbook);
  const csvText = contentToText(csvContent);
  console.log(`Synthesized CSV: ${csvText.length} characters\n`);

  // --- Stream rows without materializing the whole table ------------------
  const reader = makeCsvReader({ treatFirstRowAsHeader: true });
  const rows = reader.readRowStream!(text(csvText));

  // Take the first 5 rows
  console.log("=== First 5 rows ===");
  yield* pipe(
    rows,
    Stream.take(5),
    Stream.runForEach((row) => Effect.sync(() => console.log(row.join(", "))))
  );

  // Process in batches of 1000
  console.log("\n=== Batched processing ===");
  const batchCount = yield* pipe(
    rows,
    Stream.grouped(1000),
    Stream.runFold(0, (count, batch) => {
      console.log(`Processed batch ${count + 1}: ${batch.length} rows`);
      return count + 1;
    })
  );
  console.log(`\nTotal batches: ${batchCount}`);

  // Filter + transform while streaming
  console.log("\n=== Rows whose id starts with 'a' (first 3) ===");
  yield* pipe(
    rows,
    Stream.filter((row) => row[0]?.toLowerCase().startsWith("a") ?? false),
    Stream.take(3),
    Stream.runForEach((row) => Effect.sync(() => console.log(row.join(", "))))
  );
});

Effect.runPromise(program);
