/**
 * Advanced example: File I/O with @effect/platform
 * Demonstrates reading/writing CSV files from disk
 * 
 * Note: This example requires @effect/platform-node:
 * bun add @effect/platform-node
 */

import { Effect, pipe } from "effect";
import { FileSystem } from "@effect/platform";
// Uncomment these imports after installing @effect/platform-node:
// import { NodeFileSystem, NodeRuntime } from "@effect/platform-node";
import { csvRead, csvWrite, type TableData } from "../src/index.js";

console.log(`
⚠️  This example requires @effect/platform-node
   Install it with: bun add @effect/platform-node
   
   Then uncomment the import lines in this file.
`);

// Example: Read CSV file, transform data, write results
const processDataPipeline = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;

  // Read CSV file
  const csvContent = yield* pipe(
    fs.readFileString("input.csv"),
    Effect.orElse(() => Effect.succeed("id,value\n1,100\n2,200\n3,300"))
  );

  // Parse CSV
  const table = yield* csvRead(csvContent, {
    treatFirstRowAsHeader: true,
    trimWhitespace: true,
  });

  console.log("Loaded data:", table.dataRows.length, "rows");

  // Transform data (example: double all values)
  const transformedRows = table.dataRows.map((row) =>
    row.map((field, idx) => {
      if (idx === 1 && table.columnHeaders?.[idx] === "value") {
        const numericValue = Number(field);
        if (Number.isFinite(numericValue)) {
          return String(numericValue * 2);
        }
      }
      return field;
    })
  );

  const transformed: TableData = {
    columnHeaders: table.columnHeaders,
    dataRows: transformedRows,
  };

  // Write back to CSV
  const outputCsv = yield* csvWrite(transformed);

  // Save to file
  yield* fs.writeFileString("output.csv", outputCsv);

  console.log("Processed data written to output.csv");
  return transformed;
});

// To run this example:
// 1. Install the platform-node package: bun add @effect/platform-node
// 2. Uncomment the imports at the top of this file
// 3. Uncomment the code below:

/*
// Run with Node filesystem
const program = pipe(
  processDataPipeline,
  Effect.provide(NodeFileSystem.layer)
);

NodeRuntime.runMain(program);
*/

console.log("File I/O example (see comments for setup instructions)");
Effect.runPromise(Effect.void);
