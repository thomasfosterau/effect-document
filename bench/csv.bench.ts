/**
 * The CSV reader, scanner and writer against the leading JavaScript CSV
 * libraries: uDSV (the fastest), d3-dsv, Papa Parse and csv-parse /
 * csv-stringify.
 *
 * - **scan**: text to rows of strings (`scanCsv` against each library's
 *   string-array parse).
 * - **read**: text to typed values (`makeCsvReader().read`, which also infers
 *   column types and builds the document, and `readCsvRows`, the same
 *   inference into rows of plain values, against each library's typed parse).
 * - **stream**: the same text in 64 KiB chunks (`scanCsvStream` against
 *   Papa Parse's and csv-parse's Node streaming parsers).
 * - **write**: rows to text (`makeCsvWriter().write` from a document, and
 *   `renderTable` from strings, against each library's formatter).
 *
 * Run with `vp run bench:csv` (builds first).
 */
import {
  makeCsvReader,
  makeCsvWriter,
  readCsvRows,
  renderTable,
  scanCsv,
  scanCsvStream,
} from "@thomasfosterau/effect-csv";
import { text } from "@thomasfosterau/effect-document";
import { parse as csvParse } from "csv-parse/sync";
import { parse as csvParseStream } from "csv-parse";
import { stringify as csvStringify } from "csv-stringify/sync";
import { autoType, csvFormatRows, csvParse as d3CsvParse, csvParseRows } from "d3-dsv";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import type { Duplex } from "node:stream";
import Papa from "papaparse";
import { inferSchema, initParser } from "udsv";
import { type Case, type Group, type GroupSource, rng, runGroups } from "./harness.ts";

const random = rng(2026);
const pick = <A>(xs: ReadonlyArray<A>): A => xs[Math.floor(random() * xs.length)]!;
const words = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta", "theta"];

/** A mixed table: integers, decimals, dates, booleans, short text and some quoted text. */
const mixed = (rows: number): string => {
  const out = ["id,name,email,price,quantity,date,active,note"];
  for (let i = 0; i < rows; i++) {
    const note =
      random() < 0.2
        ? `"${pick(words)}, ""${pick(words)}"" ${pick(words)}"`
        : `${pick(words)} ${pick(words)}`;
    out.push(
      [
        i,
        `${pick(words)} ${pick(words)}`,
        `${pick(words)}.${i}@example.com`,
        (random() * 1000).toFixed(2),
        Math.floor(random() * 100),
        `2026-${String(1 + Math.floor(random() * 12)).padStart(2, "0")}-${String(1 + Math.floor(random() * 28)).padStart(2, "0")}`,
        random() < 0.5 ? "true" : "false",
        note,
      ].join(","),
    );
  }
  return out.join("\n") + "\n";
};

/** Every field quoted, with escaped quotes and quoted line breaks. */
const quoted = (rows: number): string => {
  const out = ['"a","b","c","d"'];
  for (let i = 0; i < rows; i++) {
    out.push(
      [
        `"${pick(words)} ""${i}"""`,
        `"${pick(words)}\n${pick(words)}"`,
        `"${pick(words)}, ${pick(words)}"`,
        `"${i}"`,
      ].join(","),
    );
  }
  return out.join("\r\n") + "\r\n";
};

/** Numbers only: the inference-heavy case. */
const numeric = (rows: number): string => {
  const out = ["x,y,z,w,v,u"];
  for (let i = 0; i < rows; i++) {
    out.push(
      [
        i,
        random().toFixed(6),
        (random() * 1e6).toFixed(1),
        Math.floor(random() * 1e4),
        (-random()).toFixed(3),
        i * 3,
      ].join(","),
    );
  }
  return out.join("\n") + "\n";
};

/**
 * Computed floats at full precision (17 significant digits, as JavaScript
 * prints a double): past the digits every double holds, so a lossless reader
 * must check each one reads back as written.
 */
const floats = (rows: number): string => {
  const out = ["id,label,ratio,score"];
  for (let i = 0; i < rows; i++)
    out.push(`${i},item${i},${String(i / 7)},${String(random() * 100)}`);
  return out.join("\n") + "\n";
};

/**
 * `BENCH_LARGE=1` adds a 100 MB table, run three rounds (a few minutes, and
 * a few GB of heap: `NODE_OPTIONS=--max-old-space-size=8192`).
 */
const large = process.env["BENCH_LARGE"] === "1";

const inputs = [
  { name: "mixed, 100k rows", csv: mixed(100_000), minRounds: 15 },
  { name: "quoted, 50k rows", csv: quoted(50_000), minRounds: 15 },
  { name: "numeric, 100k rows", csv: numeric(100_000), minRounds: 15 },
  { name: "floats, 100k rows", csv: floats(100_000), minRounds: 15 },
  { name: "mixed, 1k rows", csv: mixed(1_000), minRounds: 15 },
  ...(large ? [{ name: "mixed, 1.2M rows", csv: mixed(1_200_000), minRounds: 3 }] : []),
];

const run = <A, E>(effect: Effect.Effect<A, E>): A => Effect.runSync(effect);
const runP = <A, E>(effect: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(effect);
const encoder = new TextEncoder();
const bytes = (s: string) => encoder.encode(s).length;

const reader = makeCsvReader({ treatFirstRowAsHeader: true });
const lossyReader = makeCsvReader({ treatFirstRowAsHeader: true, exactNumbers: false });
const writer = makeCsvWriter();

const chunks = (s: string, size: number): Array<string> => {
  const out: Array<string> = [];
  for (let i = 0; i < s.length; i += size) out.push(s.slice(i, i + size));
  return out;
};

const scanCases = (csv: string): Array<Case> => {
  const schema = inferSchema(csv);
  const udsv = initParser(schema);
  return [
    {
      name: "effect-csv scanCsv",
      run: () => run(scanCsv(csv, undefined, { treatFirstRowAsHeader: true })),
    },
    { name: "uDSV stringArrs", run: () => udsv.stringArrs(csv) },
    { name: "d3-dsv csvParseRows", run: () => csvParseRows(csv) },
    { name: "papaparse", run: () => Papa.parse(csv, { skipEmptyLines: true }).data },
    { name: "csv-parse/sync", run: () => csvParse(csv, { skip_empty_lines: true }) },
  ];
};

const readCases = (csv: string): Array<Case> => {
  const schema = inferSchema(csv);
  const udsv = initParser(schema);
  return [
    { name: "effect-csv read", run: () => run(reader.read(text(csv))) },
    {
      name: "effect-csv read (inferTypes off)",
      run: () =>
        run(makeCsvReader({ treatFirstRowAsHeader: true, inferTypes: false }).read(text(csv))),
    },
    // typed rows rather than a document: like with like against the libraries below
    {
      name: "effect-csv readCsvRows",
      run: () => run(readCsvRows(csv, { treatFirstRowAsHeader: true })),
    },
    // numbers as `Number` reads them, digits held or not: the libraries' rule
    {
      name: "effect-csv readCsvRows (lossy)",
      run: () => run(readCsvRows(csv, { treatFirstRowAsHeader: true, exactNumbers: false })),
    },
    {
      name: "effect-csv read (lossy)",
      run: () => run(lossyReader.read(text(csv))),
    },
    {
      name: "uDSV inferSchema + typedArrs",
      run: () => initParser(inferSchema(csv)).typedArrs(csv),
    },
    { name: "uDSV typedArrs (schema cached)", run: () => udsv.typedArrs(csv) },
    { name: "d3-dsv csvParse(autoType)", run: () => d3CsvParse(csv, autoType) },
    {
      name: "papaparse dynamicTyping",
      run: () => Papa.parse(csv, { skipEmptyLines: true, dynamicTyping: true }).data,
    },
    {
      name: "csv-parse/sync cast",
      run: () => csvParse(csv, { skip_empty_lines: true, cast: true }),
    },
  ];
};

/** Write `parts` into a Node streaming parser and count the rows it emits. */
const countRows = (parser: Duplex, parts: ReadonlyArray<string>): Promise<number> =>
  new Promise<number>((resolve, reject) => {
    let n = 0;
    parser.on("data", () => n++);
    parser.on("end", () => resolve(n));
    parser.on("error", reject);
    for (const part of parts) parser.write(part);
    parser.end();
  });

const streamCases = (csv: string): Array<Case> => {
  const parts = chunks(csv, 65536);
  return [
    {
      name: "effect-csv scanCsvStream",
      run: () =>
        runP(
          Stream.runCount(
            scanCsvStream(Stream.fromIterable(parts), undefined, { treatFirstRowAsHeader: true }),
          ),
        ),
    },
    {
      name: "papaparse stream",
      run: () => countRows(Papa.parse(Papa.NODE_STREAM_INPUT, { skipEmptyLines: true }), parts),
    },
    {
      name: "csv-parse stream",
      run: () => countRows(csvParseStream({ skip_empty_lines: true }), parts),
    },
  ];
};

const writeCases = (csv: string): Array<Case> => {
  const rows = csvParseRows(csv);
  const doc = run(
    makeCsvReader({ treatFirstRowAsHeader: true, inferTypes: false }).read(text(csv)),
  );
  return [
    { name: "effect-csv write (document)", run: () => run(writer.write(doc)) },
    { name: "effect-csv renderTable", run: () => renderTable(rows) },
    { name: "d3-dsv csvFormatRows", run: () => csvFormatRows(rows) },
    { name: "papaparse unparse", run: () => Papa.unparse(rows) },
    { name: "csv-stringify/sync", run: () => csvStringify(rows) },
  ];
};

// each group built when it runs, so no group's inputs weigh on another's
const groups: Array<GroupSource> = inputs.flatMap(({ name, csv, minRounds }) =>
  (
    [
      ["scan", scanCases],
      ["read", readCases],
      ["stream", streamCases],
      ["write", writeCases],
    ] as const
  ).map(([kind, cases]) => ({
    name: `${kind}: ${name}`,
    build: (): Group => ({
      name: `${kind}: ${name}`,
      bytes: bytes(csv),
      cases: cases(csv),
      minRounds,
    }),
  })),
);

await runGroups("CSV", groups);
