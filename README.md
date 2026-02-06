# effect-csv

An Effect-native CSV toolkit providing a **unified, coherent API** for all CSV operations using the Effect ecosystem.

## Features

- 🎯 **Unified API** - Single service interface for read, write, and synthesis operations
- 🔄 **Effect-Native** - Built on Effect for composability and type safety
- 🌊 **Streaming Support** - Process large files efficiently with Effect Streams
- 🎨 **Dialect Flexibility** - Support for CSV, TSV, and custom delimiters
- 🧪 **Data Synthesis** - Generate reproducible test data with seeded randomization
- ⚡ **Bun-First** - Optimized for Bun runtime
- 🛡️ **Type Safe** - Full TypeScript support with Effect Schema integration

## Installation

```bash
bun add effect-csv effect @effect/platform
```

## Quick Start

```typescript
import { csvRead, csvWrite, csvSynthesize } from "effect-csv";
import { Effect } from "effect";

// Read CSV
const data = await Effect.runPromise(
  csvRead("name,age\nAlice,30\nBob,25", {
    treatFirstRowAsHeader: true,
  })
);

// Write CSV
const output = await Effect.runPromise(
  csvWrite({
    columnHeaders: ["name", "age"],
    dataRows: [["Alice", "30"], ["Bob", "25"]],
  })
);

// Generate test data
const testData = await Effect.runPromise(
  csvSynthesize({
    columns: ["id", "email", "username"],
    quantity: 100,
    seed: 42,
  })
);
```

## Unified Architecture

Unlike traditional CSV libraries that split functionality into separate packages (csv-parse, csv-stringify, csv-generate), effect-csv provides a **coherent, unified service** through the `Csv` interface:

```typescript
interface Csv {
  readonly read: (text: string, options?: ReadOptions) => Effect<TableData>;
  readonly write: (data: TableData) => Effect<string>;
  readonly readStream: (text: string, options?) => Stream<Row>;
  readonly synthesize: (spec: SynthesisSpec) => Effect<TableData>;
}
```

### Using the Service Pattern

```typescript
import { Effect, pipe } from "effect";
import { CsvTag, CsvLive } from "effect-csv";

const program = Effect.gen(function* () {
  const csv = yield* CsvTag;
  
  // Read data
  const table = yield* csv.read("a,b,c\n1,2,3", {
    treatFirstRowAsHeader: true,
  });
  
  // Write data
  const output = yield* csv.write(table);
  
  return output;
});

// Run with the live CSV service
Effect.runPromise(pipe(program, Effect.provide(CsvLive)));
```

## API Reference

### Reading CSV

```typescript
csvRead(text: string, options?: ReadOptions): Effect<TableData>
```

**Options:**
- `treatFirstRowAsHeader` - Parse first row as column names
- `providedHeaders` - Supply custom column headers
- `skipRows` - Skip N rows from the beginning
- `filterEmpty` - Ignore blank lines (default: true)
- `trimWhitespace` - Trim spaces from fields
- `allowVariableColumns` - Allow rows with different column counts
- `lineCommentMarker` - Skip lines starting with this character

**Examples:**

```typescript
// With headers
const data = await Effect.runPromise(
  csvRead("name,age\nAlice,30", {
    treatFirstRowAsHeader: true,
  })
);
// data.columnHeaders = ["name", "age"]
// data.dataRows = [["Alice", "30"]]

// With custom headers
const data2 = await Effect.runPromise(
  csvRead("Alice,30", {
    providedHeaders: ["name", "age"],
  })
);

// Handle quoted fields and special characters
const complex = await Effect.runPromise(
  csvRead('name,desc\n"John","Has, comma"\n"Jane","Has ""quotes"""')
);
```

### Writing CSV

```typescript
csvWrite(data: TableData): Effect<string>
```

**Example:**

```typescript
const output = await Effect.runPromise(
  csvWrite({
    columnHeaders: ["product", "price"],
    dataRows: [
      ["Laptop", "999"],
      ["Mouse", "24.99"],
    ],
  })
);
// Output:
// product,price
// Laptop,999
// Mouse,24.99
```

### Synthesizing Data

```typescript
csvSynthesize(spec: SynthesisSpec): Effect<TableData>
```

**Spec Options:**
- `columns` - Column count or array of names
- `quantity` - Number of rows to generate
- `seed` - Random seed for reproducibility
- `fieldLengthRange` - Min/max field length `[min, max]`

**Example:**

```typescript
// Generate reproducible test data
const testData = await Effect.runPromise(
  csvSynthesize({
    columns: ["id", "email", "status"],
    quantity: 1000,
    seed: 12345,
    fieldLengthRange: [5, 20],
  })
);
```

### Streaming

```typescript
import { CsvTag } from "effect-csv";
import { Stream, Effect, pipe } from "effect";

const program = Effect.gen(function* () {
  const csv = yield* CsvTag;
  
  const stream = csv.readStream(largeCSVText, {
    treatFirstRowAsHeader: true,
  });
  
  yield* pipe(
    stream,
    Stream.take(100), // Process first 100 rows
    Stream.runForEach((row) =>
      Effect.sync(() => console.log(row))
    )
  );
});
```

### Custom Dialects

```typescript
import { makeCsvLayer, type CsvDialect } from "effect-csv";

// TSV (Tab-Separated Values)
const TsvDialect: CsvDialect = {
  separator: "\t",
  linebreak: "\n",
  wrapper: '"',
  doubleWrapper: '""',
};

const program = pipe(
  CsvTag,
  Effect.flatMap((csv) => csv.read(tsvText)),
  Effect.provide(makeCsvLayer(TsvDialect))
);

// Pipe-separated values
const PipeDialect: CsvDialect = {
  separator: "|",
  linebreak: "\n",
  wrapper: '"',
  doubleWrapper: '""',
};
```

## Examples

See the [examples](./examples/) directory for complete working examples:
- `unified-demo.ts` - Comprehensive demonstration of all features

Run examples:
```bash
bun run examples/unified-demo.ts
```

## Testing

```bash
bun test
```

## Why Effect?

Effect provides:
- **Type-safe error handling** - No try/catch, errors are part of the type
- **Composability** - Combine operations using Effect's operators
- **Dependency injection** - Service pattern with Layers
- **Streaming** - Memory-efficient processing of large files
- **Testability** - Easy mocking and testing with dependency injection

## License

MIT
