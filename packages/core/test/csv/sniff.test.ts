import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { assert, describe, expect, test } from "vite-plus/test";
import { text } from "../../src/index.ts";
import {
  type CsvDialect,
  readCsvRows,
  SNIFF_SAMPLE_BYTES,
  sniffCsv,
  sniffDialect,
  sniffTsv,
} from "../../src/csv/index.ts";

const sniffed = (input: string) => Effect.runSync(sniffDialect(input));

/** A table of `rows` data rows under a header, in `dialect`, its last field quoted when it holds the separator. */
const table = (dialect: CsvDialect, rows: number): string => {
  const { separator: s, linebreak: nl } = dialect;
  const data = Array.from({ length: rows }, (_, i) =>
    [`item ${i}`, String(i * 3), `"a${s}b"`].join(s),
  );
  return [["name", "qty", "note"].join(s), ...data].join(nl) + nl;
};

const COMMA: CsvDialect = { separator: ",", linebreak: "\n", wrapper: '"', doubleWrapper: '""' };
const SEMICOLON: CsvDialect = { ...COMMA, separator: ";", linebreak: "\r\n" };
const TAB: CsvDialect = { ...COMMA, separator: "\t" };
const PIPE: CsvDialect = { ...COMMA, separator: "|", linebreak: "\r" };
const DIALECTS: ReadonlyArray<readonly [string, CsvDialect]> = [
  ["comma, LF", COMMA],
  ["semicolon, CRLF", SEMICOLON],
  ["tab, LF", TAB],
  ["pipe, CR", PIPE],
];

/** A sniffer's confidence, or 0 when it says no. */
const confidenceOf = (sniff: ReturnType<typeof sniffCsv>): number =>
  Option.match(sniff, { onNone: () => 0, onSome: (s) => s.confidence });

describe("sniffDialect (#188)", () => {
  test.each(DIALECTS)("finds the %s dialect and the header", (_, dialect) => {
    const found = sniffed(table(dialect, 20));
    assert(Option.isSome(found), "expected a dialect");
    expect(found.value.options).toEqual({ dialect, skipRows: 0, treatFirstRowAsHeader: true });
    expect(found.value.confidence).toBeGreaterThan(0.9);
  });

  test("skips a preamble before the table", () => {
    const dialect = COMMA;
    const found = sniffed(`Exported 2026-11-11\nby the report tool\n${table(dialect, 10)}`);
    assert(Option.isSome(found), "expected a dialect");
    expect(found.value.options.skipRows).toBe(2);
    expect(found.value.evidence).toContain("2 preamble line(s)");
  });

  test("says there is no header when the first row is like the rest", () => {
    const found = sniffed("a,b\nc,d\ne,f\n");
    assert(Option.isSome(found), "expected a dialect");
    expect(found.value.options.treatFirstRowAsHeader).toBe(false);
  });

  test("on a sample of a large file, agrees with reading the whole file", () => {
    const dialect = SEMICOLON;
    const big = table(dialect, 5000);
    expect(big.length).toBeGreaterThan(SNIFF_SAMPLE_BYTES);
    const found = sniffed(big);
    assert(Option.isSome(found), "expected a dialect");
    const withSniffed = Effect.runSync(readCsvRows(big, found.value.options));
    const withTruth = Effect.runSync(
      readCsvRows(big, { dialect, skipRows: 0, treatFirstRowAsHeader: true }),
    );
    expect(withSniffed).toEqual(withTruth);
  });

  test("finds nothing in text no separator splits", () => {
    expect(Option.isNone(sniffed("one line of prose\nand another\n"))).toBe(true);
  });
});

describe("sniffCsv / sniffTsv (#188)", () => {
  test("are sure of consistent rows of their own separator only", () => {
    const csv = text(table(COMMA, 5));
    const tsv = text(table(TAB, 5));
    expect(confidenceOf(sniffCsv(csv))).toBeGreaterThan(0.8);
    expect(confidenceOf(sniffTsv(tsv))).toBeGreaterThan(0.8);
    expect(confidenceOf(sniffTsv(csv))).toBeLessThan(0.2);
  });

  test("refuse binary content", () => {
    const bytes = { _tag: "Bytes" as const, bytes: new Uint8Array([97, 0, 44, 98]) };
    expect(Option.isNone(sniffCsv(bytes))).toBe(true);
  });
});
