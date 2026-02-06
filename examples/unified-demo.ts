/**
 * Examples demonstrating the unified CSV API
 */

import { Effect, pipe } from "effect";
import {
  csvRead,
  csvWrite,
  csvSynthesize,
  type TableData,
} from "../src/index.js";

console.log("=== Effect-CSV Unified API Examples ===\n");

// Example 1: Reading CSV with headers
const example1 = Effect.gen(function* () {
  console.log("Example 1: Reading CSV with headers");
  
  const csvText = `name,age,city
Alice,30,Seattle
Bob,25,Portland
Carol,35,Vancouver`;

  const table = yield* csvRead(csvText, {
    treatFirstRowAsHeader: true,
    trimWhitespace: true,
  });

  console.log("Headers:", table.columnHeaders);
  console.log("Rows:", table.dataRows);
  console.log();
});

// Example 2: Writing table data to CSV
const example2 = Effect.gen(function* () {
  console.log("Example 2: Writing table data to CSV");

  const tableData: TableData = {
    columnHeaders: ["product", "price", "stock"],
    dataRows: [
      ["Laptop", "999.99", "15"],
      ["Mouse", "24.99", "150"],
      ["Keyboard", "79.99", "75"],
    ],
  };

  const output = yield* csvWrite(tableData);
  console.log("Generated CSV:");
  console.log(output);
});

// Example 3: Synthesizing random data
const example3 = Effect.gen(function* () {
  console.log("Example 3: Synthesizing random test data");

  const syntheticData = yield* csvSynthesize({
    columns: ["id", "username", "email"],
    quantity: 5,
    seed: 42, // Reproducible results
    fieldLengthRange: [8, 15],
  });

  console.log("Synthetic data headers:", syntheticData.columnHeaders);
  console.log("Sample rows:");
  syntheticData.dataRows.slice(0, 3).forEach((row, idx) => {
    console.log(`  Row ${idx + 1}:`, row);
  });
  console.log();
});

// Example 4: Handling quoted fields and special characters
const example4 = Effect.gen(function* () {
  console.log("Example 4: Handling quoted fields");

  const complexCsv = `title,description
"Simple product","A basic item"
"Complex, product","This has a comma, and ""quotes"" too"`;

  const parsed = yield* csvRead(complexCsv, {
    treatFirstRowAsHeader: true,
  });

  console.log("Parsed complex CSV:");
  parsed.dataRows.forEach((row, idx) => {
    console.log(`  Row ${idx + 1}:`, row);
  });
  console.log();
});

// Example 5: Round-trip (read then write)
const example5 = Effect.gen(function* () {
  console.log("Example 5: Round-trip conversion");

  const original = `fruit,color,quantity
apple,red,10
banana,yellow,20
grape,purple,30`;

  const table = yield* csvRead(original, {
    treatFirstRowAsHeader: true,
  });

  const recreated = yield* csvWrite(table);

  console.log("Original CSV:");
  console.log(original);
  console.log("\nRecreated CSV:");
  console.log(recreated);
  console.log("Match:", original + "\n" === recreated);
  console.log();
});

// Example 6: Working with TSV (tab-separated values)
const example6 = Effect.gen(function* () {
  console.log("Example 6: TSV support");

  const { CsvTag, makeCsvLayer, TsvDialect } = 
    require("../src/index.js") as typeof import("../src/index.js");

  const tsvText = "name\tage\tcity\nDave\t28\tBoston\nEve\t32\tAustin";

  const result = yield* pipe(
    CsvTag,
    Effect.flatMap((csv) =>
      csv.read(tsvText, { treatFirstRowAsHeader: true })
    ),
    Effect.provide(makeCsvLayer(TsvDialect))
  );

  console.log("Parsed TSV:");
  console.log("Headers:", result.columnHeaders);
  console.log("Rows:", result.dataRows);
  console.log();
});

// Run all examples
const runAllExamples = Effect.gen(function* () {
  yield* example1;
  yield* example2;
  yield* example3;
  yield* example4;
  yield* example5;
  yield* example6;
});

Effect.runPromise(runAllExamples).catch(console.error);
