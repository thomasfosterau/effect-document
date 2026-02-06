/**
 * Advanced example: Processing large CSV files with streaming
 * Demonstrates memory-efficient processing
 */

import { Effect, Stream, pipe } from "effect";
import { CsvTag, CsvLive, csvSynthesize, csvWrite } from "../src/index.js";

// Example: Stream processing for large datasets
const streamingExample = Effect.gen(function* () {
  console.log("=== Streaming CSV Processing Example ===\n");

  // Generate a large dataset
  console.log("1. Generating large dataset...");
  const largeDataset = yield* csvSynthesize({
    columns: ["id", "name", "score", "status"],
    quantity: 10000,
    seed: 999,
  });

  const csvText = yield* csvWrite(largeDataset);
  console.log(`   Generated ${largeDataset.dataRows.length} rows\n`);

  // Stream process: read CSV and filter rows
  console.log("2. Stream processing (filter rows where index < 100)...");
  
  const csv = yield* CsvTag;
  const stream = csv.readStream(csvText, {
    treatFirstRowAsHeader: true,
  });

  let processedCount = 0;
  const filteredRows: string[][] = [];

  yield* pipe(
    stream,
    Stream.take(100), // Only process first 100 rows
    Stream.runForEach((row) =>
      Effect.sync(() => {
        processedCount++;
        if (Array.isArray(row)) {
          filteredRows.push([...row]);
        }
      })
    )
  );

  console.log(`   Processed ${processedCount} rows via streaming`);
  console.log(`   Collected ${filteredRows.length} filtered rows\n`);

  // Example: Chunked processing for batching
  console.log("3. Chunked streaming (process in batches of 50)...");

  const batchStream = csv.readStream(csvText, {
    treatFirstRowAsHeader: true,
  });

  let batchNumber = 0;

  yield* pipe(
    batchStream,
    Stream.take(200),
    Stream.chunks,
    Stream.mapChunks((chunk) => {
      batchNumber++;
      console.log(`   Processing batch ${batchNumber}, size: ${chunk.length}`);
      return chunk;
    }),
    Stream.runDrain
  );

  console.log("\n✓ Streaming examples completed");
});

// Run the example
const program = pipe(
  streamingExample,
  Effect.provide(CsvLive)
);

Effect.runPromise(program).catch(console.error);
