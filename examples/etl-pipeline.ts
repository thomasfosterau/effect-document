/**
 * Real-world example: ETL Pipeline
 * Extract, Transform, Load pattern using Effect CSV
 */

import { Effect, pipe } from "effect";
import { csvRead, csvWrite, csvSynthesize, type TableData } from "../src/index.js";

// Simulate extracting data from source
const extractPhase = Effect.gen(function* () {
  console.log("📥 EXTRACT: Generating source data...");
  
  const sourceData = yield* csvSynthesize({
    columns: ["user_id", "raw_score", "timestamp"],
    quantity: 50,
    seed: 777,
    fieldLengthRange: [5, 12],
  });

  console.log(`   Extracted ${sourceData.dataRows.length} records\n`);
  return sourceData;
});

// Transform the data
const transformPhase = (data: TableData) =>
  Effect.gen(function* () {
    console.log("🔄 TRANSFORM: Processing records...");

    if (!data.columnHeaders) {
      yield* Effect.fail(new Error("Headers required for transformation"));
    }

    // Add computed columns
    const newHeaders = [
      ...(data.columnHeaders ?? []),
      "processed_date",
      "quality_score",
    ];

    const transformedRows = data.dataRows.map((row, idx) => {
      // Simulate transformation logic
      const processedDate = new Date().toISOString().split("T")[0];
      const qualityScore = ((idx + 1) * 7) % 100;

      return [...row, processedDate!, String(qualityScore)];
    });

    console.log("   ✓ Added computed columns");
    console.log(`   ✓ Transformed ${transformedRows.length} records\n`);

    return {
      columnHeaders: newHeaders,
      dataRows: transformedRows,
    };
  });

// Load data to destination (simulate with CSV output)
const loadPhase = (data: TableData) =>
  Effect.gen(function* () {
    console.log("💾 LOAD: Writing to destination...");

    const csvOutput = yield* csvWrite(data);
    
    // In real world, this would write to database/file/API
    const lineCount = csvOutput.split("\n").filter((l) => l.trim()).length;
    
    console.log(`   ✓ Wrote ${lineCount} lines (including header)`);
    console.log("   ✓ Data loaded successfully\n");

    return csvOutput;
  });

// Complete ETL pipeline
const etlPipeline = pipe(
  extractPhase,
  Effect.flatMap(transformPhase),
  Effect.flatMap(loadPhase),
  Effect.tap(() =>
    Effect.sync(() => console.log("✅ ETL Pipeline completed successfully"))
  )
);

// Example 2: Data validation pipeline
const validationPipeline = Effect.gen(function* () {
  console.log("\n" + "=".repeat(50));
  console.log("🔍 DATA VALIDATION PIPELINE");
  console.log("=".repeat(50) + "\n");

  // Input CSV with potential issues
  const inputCsv = `email,age,score
valid@example.com,25,95
invalid-email,30,88
another@test.org,17,92
test@domain.com,45,101`;

  const data = yield* csvRead(inputCsv, {
    treatFirstRowAsHeader: true,
    trimWhitespace: true,
  });

  console.log(`📊 Validating ${data.dataRows.length} records...\n`);

  // Validation logic
  interface ValidationResult {
    valid: ReadonlyArray<string>[];
    invalid: Array<{ row: ReadonlyArray<string>; reason: string }>;
  }

  const result: ValidationResult = { valid: [], invalid: [] };

  for (const row of data.dataRows) {
    const [email, age, score] = row;

    // Simple validation rules
    if (!email?.includes("@")) {
      result.invalid.push({ row, reason: "Invalid email format" });
    } else if (parseInt(age!) < 18) {
      result.invalid.push({ row, reason: "Age below minimum (18)" });
    } else if (parseInt(score!) > 100) {
      result.invalid.push({ row, reason: "Score exceeds maximum (100)" });
    } else {
      result.valid.push(row);
    }
  }

  console.log(`✅ Valid records: ${result.valid.length}`);
  console.log(`❌ Invalid records: ${result.invalid.length}`);

  if (result.invalid.length > 0) {
    console.log("\nInvalid records:");
    result.invalid.forEach(({ row, reason }) => {
      console.log(`   - ${row.join(", ")} → ${reason}`);
    });
  }

  // Write valid records only
  const validData: TableData = {
    columnHeaders: data.columnHeaders,
    dataRows: result.valid,
  };

  const validCsv = yield* csvWrite(validData);
  console.log("\n📤 Output (valid records only):");
  console.log(validCsv);
});

// Run both examples
const runAll = Effect.gen(function* () {
  console.log("=".repeat(50));
  console.log("REAL-WORLD CSV PROCESSING EXAMPLES");
  console.log("=".repeat(50) + "\n");

  yield* etlPipeline;
  yield* validationPipeline;
});

Effect.runPromise(runAll).catch(console.error);
