/**
 * Streaming CSV rows with Effect Streams - process large inputs without
 * materializing the whole table, and synthesize test data to stream.
 *
 * Run with: vp exec tsx examples/streaming.ts
 */

import { Effect, Stream, pipe } from "effect";
import { contentToText, text } from "@thomasfosterau/effect-document";
import { makeCsvReader, makeCsvWriter, synthesizeDocument } from "@thomasfosterau/effect-csv";

const program = Effect.gen(function* () {
  // --- Synthesize a big CSV-profile document to play with -----------------
  const doc = yield* synthesizeDocument({
    columns: ["id", "name", "email"],
    quantity: 10_000,
    seed: 42,
  });

  const csvContent = yield* makeCsvWriter().write(doc);
  const csvText = contentToText(csvContent);
  console.log(`Synthesized CSV: ${csvText.length} characters\n`);

  // --- Stream rows without materializing the whole table ------------------
  const reader = makeCsvReader();
  const rows = reader.readStream!(text(csvText));

  console.log("=== First 5 rows ===");
  yield* pipe(
    rows,
    Stream.take(5),
    Stream.runForEach((row) => Effect.sync(() => console.log(row.join(", "))))
  );

  console.log("\n=== Batched processing ===");
  const batchCount = yield* pipe(
    rows,
    Stream.grouped(1000),
    Stream.runFold(() => 0, (count: number, batch) => {
      console.log(`Processed batch ${count + 1}: ${batch.length} rows`);
      return count + 1;
    })
  );
  console.log(`\nTotal batches: ${batchCount}`);
});

Effect.runPromise(program);
