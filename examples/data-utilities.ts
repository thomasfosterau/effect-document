/**
 * Utility example: Working with different data formats
 * Convert between arrays, objects, and CSV
 */

import { Effect } from "effect";
import { csvRead, csvWrite, type TableData } from "../src/index.js";

console.log("=== CSV Data Format Utilities ===\n");

// Helper: Convert TableData to array of objects
function tableToObjects(table: TableData): Record<string, string>[] {
  if (!table.columnHeaders) {
    throw new Error("Cannot convert to objects without column headers");
  }

  return table.dataRows.map((row) => {
    const obj: Record<string, string> = {};
    table.columnHeaders!.forEach((header, idx) => {
      obj[header] = row[idx] ?? "";
    });
    return obj;
  });
}

// Helper: Convert array of objects to TableData
function objectsToTable<T extends Record<string, any>>(
  objects: T[]
): TableData {
  if (objects.length === 0) {
    return { columnHeaders: null, dataRows: [] };
  }

  const headers = Object.keys(objects[0]!);
  const rows = objects.map((obj) => headers.map((h) => String(obj[h] ?? "")));

  return {
    columnHeaders: headers,
    dataRows: rows,
  };
}

// Example usage
const example = Effect.gen(function* () {
  // Start with typed objects
  interface Person {
    name: string;
    age: number;
    city: string;
  }

  const people: Person[] = [
    { name: "Alice", age: 30, city: "Seattle" },
    { name: "Bob", age: 25, city: "Portland" },
    { name: "Carol", age: 35, city: "Vancouver" },
  ];

  console.log("1. Original typed objects:");
  console.log(people);
  console.log();

  // Convert to TableData
  const table = objectsToTable(people);
  console.log("2. Converted to TableData:");
  console.log("   Headers:", table.columnHeaders);
  console.log("   Rows:", table.dataRows);
  console.log();

  // Convert to CSV string
  const csvString = yield* csvWrite(table);
  console.log("3. Converted to CSV:");
  console.log(csvString);

  // Parse back from CSV
  const parsed = yield* csvRead(csvString, {
    treatFirstRowAsHeader: true,
  });

  // Convert back to objects
  const recovered = tableToObjects(parsed);
  console.log("4. Recovered as typed objects:");
  console.log(recovered);
  console.log();

  // Demonstrate type safety
  console.log("5. Type-safe access:");
  recovered.forEach((person) => {
    console.log(`   ${person.name} is ${person.age} years old`);
  });
});

Effect.runPromise(example).catch(console.error);
