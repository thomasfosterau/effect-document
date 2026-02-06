/**
 * Advanced example: File I/O with @effect/platform
 * Demonstrates reading/writing CSV files from disk
 */

import { Effect, pipe } from "effect";
import { FileSystem } from "@effect/platform";
import { NodeFileSystem, NodeRuntime } from "@effect/platform-node";
import { csvRead, csvWrite, type TableData } from "../src/index.js";

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
        return String(parseInt(field) * 2);
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

// Run with Node filesystem
const program = pipe(
  processDataPipeline,
  Effect.provide(NodeFileSystem.layer)
);

NodeRuntime.runMain(program);
