/**
 * Streaming CSV rows with Effect Streams - process large inputs without
 * materializing the whole table, and synthesize test data to stream.
 *
 * Run with: vp exec tsx examples/streaming.ts (after `vp run -r build`)
 */

import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { contentToText, text } from "@thomasfosterau/effect-document";
import { makeCsvReader, makeCsvWriter, synthesizeDocument } from "@thomasfosterau/effect-csv";

const program = Effect.fn("streaming")(function* () {
  // --- Synthesize a big CSV-profile document to play with -----------------
  const doc = yield* synthesizeDocument({
    columns: ["id", "name", "email"],
    quantity: 10_000,
    seed: 42,
  });

  const csvContent = yield* makeCsvWriter().write(doc);
  const csvText = contentToText(csvContent);
  yield* Console.log(`Synthesized CSV: ${csvText.length} characters\n`);

  // --- Stream rows without materializing the whole table ------------------
  // `readStream` is optional on a Reader; the CSV reader always provides it.
  const { readStream } = makeCsvReader();
  if (readStream === undefined) return yield* Effect.die("the CSV reader streams");
  const rows = readStream(text(csvText));

  yield* Console.log("=== First 5 rows ===");
  yield* rows.pipe(
    Stream.take(5),
    Stream.runForEach((row) => Console.log(row.join(", "))),
  );

  yield* Console.log("\n=== Batched processing ===");
  const batchCount = yield* rows.pipe(
    Stream.grouped(1000),
    Stream.runFoldEffect(
      () => 0,
      (count: number, batch) =>
        Console.log(`Processed batch ${count + 1}: ${batch.length} rows`).pipe(
          Effect.as(count + 1),
        ),
    ),
  );
  yield* Console.log(`\nTotal batches: ${batchCount}`);
});

Effect.runPromise(program());
