import { it } from "@effect/vitest";
import * as Arr from "effect/Array";
import * as Predicate from "effect/Predicate";
import { assert, describe, expect, test } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Equivalence from "effect/Equivalence";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { pipe } from "effect/Function";
import {
  cell,
  document,
  Document,
  encodeDocument,
  type ParseError,
  type SheetCell,
  SheetRow,
  type WorksheetRow,
  isPlainRow,
  rowCellsOf,
  rowEntries,
  sheetRow,
  sparseRow,
  text,
  trustAs,
  Worksheet,
  worksheet,
} from "@thomasfosterau/effect-document";
import {
  type CsvDialect,
  type CsvFeature,
  type ScannedTable,
  type CsvReaderOptions,
  type CsvWriterOptions,
  Rfc4180Dialect,
  StandardDialect,
  TsvDialect,
  formatCsvNumber,
  inferCell,
  makeCsvReader,
  makeCsvWriter,
  readCsvRows,
  renderCsvStream,
  renderField,
  renderTable,
  scanCsv,
  scanCsvStream,
  synthesizeDocument,
} from "../../src/csv/index.ts";

/** A printed number with its last digit nudged each way: decimals that no longer print as written. */
const nudged = (s: string): Array<string> => {
  const last = s.charCodeAt(s.length - 1) - 48;
  return [last - 1, last + 1, last + 2]
    .filter((d) => d >= 1 && d <= 9)
    .map((d) => s.slice(0, -1) + String(d));
};

/** A number's significant digits: from the first non-zero digit to the last. */
const significantDigits = (d: string) => d.replace(/^0+/, "").replace(/0+$/, "");

/** A CSV row's cells as nodes: the reader writes every field, so a row has no gaps. */
const cellsOf = (row: WorksheetRow) => rowEntries(row).map(([, c]) => c);

/** A document's first worksheet; fails the test when it has none. */
const firstWorksheet = (doc: Document): Worksheet => {
  const ws = doc.blocks.find((b) => Predicate.isTagged(b, "Worksheet"));
  assert(ws !== undefined && Predicate.isTagged(ws, "Worksheet"), "no worksheet");
  return ws;
};

// value-by-value inference on headerless input, unless a test says otherwise
const readValues = (input: string, options?: CsvReaderOptions) =>
  Effect.gen(function* () {
    return firstWorksheet(
      yield* makeCsvReader({ treatFirstRowAsHeader: false, inference: "cell", ...options }).read(
        text(input),
      ),
    ).rows.map((r) => cellsOf(r).map((c) => ("value" in c ? c.value : null)));
  });

/** The cell values the reader gives a small typed table under `options`. */
const defaultValues = (options?: CsvReaderOptions) =>
  Effect.gen(function* () {
    const doc = yield* makeCsvReader(options).read(text("id,code,n\n1,007,2.5\n2,8,3\n"));
    return firstWorksheet(doc).rows.map((r) =>
      cellsOf(r).map((c) => ("value" in c ? c.value : null)),
    );
  });

/** The cell values the reader gives `input` under `options`, header sniffing included. */
const sniffedValues = (input: string, options?: CsvReaderOptions) =>
  Effect.gen(function* () {
    return firstWorksheet(yield* makeCsvReader(options).read(text(input))).rows.map((r) =>
      cellsOf(r).map((c) => ("value" in c ? c.value : null)),
    );
  });

describe("CSV reader", () => {
  it.effect("infers number/boolean/blank cells", () =>
    Effect.gen(function* () {
      const doc = yield* makeCsvReader({ treatFirstRowAsHeader: false }).read(
        text("alice,30,true\nbob,,false\n"),
      );
      const ws = firstWorksheet(doc);
      expect(cellsOf(ws.rows[0]!).map((c) => c._tag)).toEqual([
        "CellText",
        "CellNumber",
        "CellBoolean",
      ]);
      expect(cellsOf(ws.rows[1]!)[1]!._tag).toBe("CellBlank");
    }),
  );

  it.effect("inferTypes: false keeps every value as text", () =>
    Effect.gen(function* () {
      const doc = yield* makeCsvReader({ inferTypes: false }).read(text("1,true\n"));
      const ws = firstWorksheet(doc);
      expect(cellsOf(ws.rows[0]!).every((c) => Predicate.isTagged(c, "CellText"))).toBe(true);
    }),
  );

  it.effect("header row is read as text cells", () =>
    Effect.gen(function* () {
      const doc = yield* makeCsvReader({ treatFirstRowAsHeader: true }).read(
        text("name,age\nalice,30\n"),
      );
      const ws = firstWorksheet(doc);
      expect(cellsOf(ws.rows[0]!).map((c) => c._tag)).toEqual(["CellText", "CellText"]);
      expect(cellsOf(ws.rows[1]!)[1]).toMatchObject({ _tag: "CellNumber", value: 30 });
    }),
  );

  it.effect("produces a document conforming to the CSV profile", () =>
    Effect.gen(function* () {
      const reader = makeCsvReader();
      const doc = yield* reader.read(text("a,1\nb,2\n"));
      expect(reader.profile.is(doc)).toBe(true);
    }),
  );

  test("classifies numbers as the plain-decimal grammar does", () => {
    // The reference is the grammar as a regular expression with the
    // digits check, the classifier's general path: the allocation-free
    // matcher of the default syntax must agree with it on every value.
    const grammar = /^(-?)(0|[1-9]\d*)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/;
    const reference = (raw: string): SheetCell => {
      if (raw === "") return cell.blank();
      const lower = raw.toLowerCase();
      if (lower === "true" || lower === "false") return cell.boolean(lower === "true");
      const m = grammar.exec(raw);
      if (m === null) return cell.text(raw);
      const [, sign, int = "", frac = "", exp = "0"] = m;
      const value = Number(`${sign}${int}.${frac || "0"}e${exp}`);
      const shortest = Math.abs(value).toExponential().replace(/e.*$/, "").replace(".", "");
      return significantDigits(shortest) === significantDigits(int + frac)
        ? cell.number(value)
        : cell.text(raw);
    };
    // a Lehmer generator, so the values are the same on every run
    let seed = 2026;
    const next = (n: number) => {
      seed = (seed * 48271) % 2147483647;
      return seed % n;
    };
    const alphabet = "0123456789-+.eE x";
    const samples = Array.from({ length: 20000 }, () =>
      Array.from({ length: 1 + next(20) }, () => alphabet[next(alphabet.length)]).join(""),
    );
    for (const raw of [...samples, "-", "-0", "0.0", "1e", "1e+", "1e-5", "-0e0", "9".repeat(16)]) {
      expect(inferCell(raw), raw).toEqual(reference(raw));
    }
    // long decimals (16 digits and more), which the classifier reads from
    // their digits without `Number`: printed doubles at every magnitude, the
    // same with a last digit nudged or a digit added (no longer the shortest
    // form), random digit strings, and integers about 2^53
    const unit = () => next(2147483647) / 2147483647;
    const randomDigits = (): string => {
      const n = 15 + next(4);
      const digits = String(1 + next(9)) + Arr.makeBy(n - 1, () => String(next(10))).join("");
      const point = next(n + 1);
      return point === n
        ? digits
        : point === 0
          ? `0.${"0".repeat(next(4))}${digits}`
          : `${digits.slice(0, point)}.${digits.slice(point)}`;
    };
    const long = Arr.flatten(
      Arr.makeBy(12000, () => {
        const printed = String((next(2) === 0 ? -1 : 1) * unit() * 10 ** (next(34) - 12));
        return [printed, ...nudged(printed), `${printed}1`, `${printed}0`, randomDigits()];
      }),
    );
    const nearTwo53 = Arr.makeBy(2000, (i) => String(2 ** 53 + i - 1000));
    // powers of two and the doubles either side of them, where the gap to the
    // next double up is twice the gap down (decimal.ts's ulpOf)
    const nearPowers = Arr.makeBy(140, (i) => 2 ** (i - 70)).flatMap((p) =>
      [p, p * (1 + 2 ** -52), p * (1 - 2 ** -53), p * 3, p * (3 + 2 ** -51)].map(String),
    );
    const mismatches = [
      ...long,
      ...nearTwo53,
      ...nearPowers,
      "0.10000000000000001",
      "9007199254740993",
    ].filter((raw) => !Equal.equals(inferCell(raw), reference(raw)));
    expect(mismatches.slice(0, 5)).toEqual([]);
    // with exactNumbers off, whatever the grammar matches is `Number` of it,
    // its digits held or not; anything else is as before
    const lossy = (raw: string): SheetCell =>
      grammar.test(raw) ? cell.number(Number(raw)) : reference(raw);
    const lossyMismatches = [...samples, ...long, ...nearTwo53, "0.10000000000000001"].filter(
      (raw) => !Equal.equals(inferCell(raw, { exactNumbers: false }), lossy(raw)),
    );
    expect(lossyMismatches.slice(0, 5)).toEqual([]);
  });

  it.effect("exactNumbers: false reads digits a double cannot hold as numbers", () =>
    Effect.gen(function* () {
      const csv = "id,x\n12345678901234567890,0.10000000000000001\n";
      expect(yield* readCsvRows(csv, { treatFirstRowAsHeader: true })).toEqual({
        headers: ["id", "x"],
        rows: [["12345678901234567890", "0.10000000000000001"]],
      });
      expect(yield* readCsvRows(csv, { exactNumbers: false, treatFirstRowAsHeader: true })).toEqual(
        {
          headers: ["id", "x"],
          rows: [[Number("12345678901234567890"), 0.1]],
        },
      );
    }),
  );

  it.effect("types a column as every non-null value in it is typed, else as text", () =>
    Effect.gen(function* () {
      // a reference from per-cell inference: a column keeps a type only if all
      // its non-null values have it; a text column keeps nulls as blanks
      const pools = [
        ["1", "-2", "3.5", "1e3", "0", "", "12345678901234567890"],
        ["true", "false", "TRUE", ""],
        ["a", "b", "", "1"],
        ["", ""],
        ["7", "8", "9"],
      ];
      let seed = 11;
      const next = (n: number) => {
        seed = (seed * 48271) % 2147483647;
        return seed % n;
      };
      const rows = Arr.makeBy(300, () => pools.map((pool) => pool[next(pool.length)] ?? ""));
      const csv = ["c0,c1,c2,c3,c4", ...rows.map((r) => r.join(","))].join("\n") + "\n";
      const doc = yield* makeCsvReader({ treatFirstRowAsHeader: true }).read(text(csv));
      const read = firstWorksheet(doc)
        .rows.slice(1)
        .map((row) => cellsOf(row));
      const kinds = pools.map((_, c) => {
        const tags = Arr.dedupe(
          rows.map((r) => inferCell(r[c] ?? "")._tag).filter((tag) => tag !== "CellBlank"),
        );
        return tags.length === 1 ? tags[0] : "CellText";
      });
      const expected = rows.map((r) =>
        r.map((raw, c) => {
          const inferred = inferCell(raw);
          if (Predicate.isTagged(inferred, "CellBlank")) return inferred;
          return kinds[c] === "CellText" ? cell.text(raw) : inferred;
        }),
      );
      expect(read).toEqual(expected);
    }),
  );

  it.effect("reads only plain decimals as numbers", () =>
    Effect.gen(function* () {
      expect(inferCell("007")).toEqual(cell.text("007"));
      const values = [
        "007",
        "02134",
        "0x1F",
        "0b11",
        "+1",
        " 12 ",
        "1.",
        ".5",
        "Infinity",
        "12345678901234567890",
        "1234567890.12345",
        "0",
        "-12.5",
        "1e3",
        "1000000000000000000000",
        "0.000123",
      ];
      expect((yield* readValues(values.join(",")))[0]).toEqual([
        "007",
        "02134",
        "0x1F",
        "0b11",
        "+1",
        " 12 ",
        "1.",
        ".5",
        "Infinity",
        "12345678901234567890",
        1234567890.12345,
        0,
        -12.5,
        1000,
        1e21,
        0.000123,
      ]);
    }),
  );

  it.effect("keeps a value a number only when a double holds its digits (#88)", () =>
    Effect.gen(function* () {
      const values = [
        "0.30000000000000004",
        "9007199254740992",
        "9007199254740993",
        "1e400",
        "7.10",
      ];
      expect((yield* readValues(values.join(",")))[0]).toEqual([
        0.30000000000000004,
        9007199254740992,
        "9007199254740993",
        "1e400",
        7.1,
      ]);
    }),
  );

  it.effect("booleans are case-insensitive and configurable", () =>
    Effect.gen(function* () {
      expect(yield* readValues("TRUE,False,yes\n")).toEqual([[true, false, "yes"]]);
      expect(yield* readValues("TRUE,true\n", { booleansCaseSensitive: true })).toEqual([
        ["TRUE", true],
      ]);
      expect(yield* readValues("yes,NO,true\n", { booleans: ["yes", "no"] })).toEqual([
        [true, false, "true"],
      ]);
      expect(yield* readValues("true\n", { booleans: false })).toEqual([["true"]]);
    }),
  );

  it.effect("decimalChar, groupChar and percent", () =>
    Effect.gen(function* () {
      const options: CsvReaderOptions = {
        dialect: { ...TsvDialect },
        decimalChar: ",",
        groupChar: ".",
        percent: true,
      };
      expect(yield* readValues("1.234,56\t1234,5\t12%\t7%\t1.23,4\t12,34.5\n", options)).toEqual([
        [1234.56, 1234.5, 0.12, 0.07, "1.23,4", "12,34.5"],
      ]);
      expect(yield* readValues('"1,234.56",12%\n', { groupChar: "," })).toEqual([[1234.56, "12%"]]);
    }),
  );

  it.effect("nullValues become blank cells", () =>
    Effect.gen(function* () {
      const doc = yield* makeCsvReader({
        nullValues: ["", "NA", "NULL"],
        treatFirstRowAsHeader: false,
      }).read(text("NA,NULL,,na\n"));
      expect(cellsOf(firstWorksheet(doc).rows[0]!).map((c) => c._tag)).toEqual([
        "CellBlank",
        "CellBlank",
        "CellBlank",
        "CellText",
      ]);
    }),
  );

  it.effect("column inference types a column by all its values", () =>
    Effect.gen(function* () {
      const input = "1,true,a,1\n2,false,,x\n,TRUE,b,3\n";
      expect(yield* readValues(input, { inference: "column" })).toEqual([
        [1, true, "a", "1"],
        [2, false, null, "x"],
        [null, true, "b", "3"],
      ]);
      expect(yield* readValues(input, { inference: "cell" })).toEqual([
        [1, true, "a", 1],
        [2, false, null, "x"],
        [null, true, "b", 3],
      ]);
      // the header row is excluded from inference
      expect(
        yield* readValues("id,ok\n1,true\n", { inference: "column", treatFirstRowAsHeader: true }),
      ).toEqual([
        ["id", "ok"],
        [1, true],
      ]);
    }),
  );

  it.effect("by default the header row is sniffed and each column is typed as a whole (#88)", () =>
    Effect.gen(function* () {
      const expected = [
        ["id", "code", "n"],
        // `007` keeps the whole code column text, so `8` stays as written too
        [1, "007", 2.5],
        [2, "8", 3],
      ];
      expect(yield* defaultValues()).toEqual(expected);
      // an optional forwarded as `undefined` still means the default
      expect(
        yield* defaultValues({ treatFirstRowAsHeader: undefined, inference: undefined }),
      ).toEqual(expected);
      expect(yield* defaultValues({ inference: "cell" })).toEqual([
        ["id", "code", "n"],
        [1, "007", 2.5],
        [2, 8, 3],
      ]);
      expect((yield* defaultValues({ treatFirstRowAsHeader: false }))[1]).toEqual([
        "1",
        "007",
        "2.5",
      ]);
    }),
  );

  it.effect(
    "header sniffing: a typed first row is data, an all-text file has no header (#88)",
    () =>
      Effect.gen(function* () {
        // no text first row: headerless numbers
        expect(yield* sniffedValues("1,2\n3,4\n")).toEqual([
          [1, 2],
          [3, 4],
        ]);
        // every column text: nothing tells a header apart, so the first row is data
        expect(yield* sniffedValues("name,city\nalice,paris\n")).toEqual([
          ["name", "city"],
          ["alice", "paris"],
        ]);
        // a blank in the first row: not a header, so the numbers make that column text
        expect(yield* sniffedValues("id,\n1,2\n")).toEqual([
          ["id", null],
          ["1", 2],
        ]);
        // one row: no data to compare against
        expect(yield* sniffedValues("a,b\n")).toEqual([["a", "b"]]);
        // an explicit setting overrides the sniff either way
        expect(yield* sniffedValues("1,2\n3,4\n", { treatFirstRowAsHeader: true })).toEqual([
          ["1", "2"],
          [3, 4],
        ]);
        expect(yield* sniffedValues("id,n\n1,2\n", { treatFirstRowAsHeader: false })).toEqual([
          ["id", "n"],
          ["1", "2"],
        ]);
      }),
  );

  it.effect("readStream yields rows", () =>
    Effect.gen(function* () {
      const rows = yield* pipe(
        makeCsvReader({ treatFirstRowAsHeader: false }).readStream!(text("a,b\nc,d\n")),
        Stream.runCollect,
      );
      expect([...rows]).toEqual([
        ["a", "b"],
        ["c", "d"],
      ]);
    }),
  );
});

// the grammar under test, on headerless input unless a test says otherwise
const scannedRows = (input: string, options?: Parameters<typeof scanCsv>[2]) =>
  Effect.gen(function* () {
    return (yield* scanCsv(input, undefined, { treatFirstRowAsHeader: false, ...options })).rows;
  });

describe("CSV scanner", () => {
  it.effect("quoted fields may contain separators, doubled quotes and line breaks", () =>
    Effect.gen(function* () {
      expect(yield* scannedRows('a,"b,""c""\nd"\ne,f')).toEqual([
        ["a", 'b,"c"\nd'],
        ["e", "f"],
      ]);
    }),
  );

  it.effect("a wrapper inside an unquoted field is literal", () =>
    Effect.gen(function* () {
      expect(yield* scannedRows('12" pizza,3\n6" sub,2\n')).toEqual([
        ['12" pizza', "3"],
        ['6" sub', "2"],
      ]);
      expect(yield* scannedRows('"a"b,c')).toEqual([["ab", "c"]]);
    }),
  );

  it.effect("quoteAnywhere: quoted and unquoted segments mix within a field", () =>
    Effect.gen(function* () {
      expect(yield* scannedRows('x"y,z"w,""', { quoteAnywhere: true })).toEqual([["xy,zw", ""]]);
    }),
  );

  it.effect("an empty wrapper turns quoting off", () =>
    Effect.gen(function* () {
      const dialect = { ...StandardDialect, wrapper: "", doubleWrapper: "" };
      expect((yield* scanCsv('"a,b"\n', dialect, { treatFirstRowAsHeader: false })).rows).toEqual([
        ['"a', 'b"'],
      ]);
    }),
  );

  it.effect("multi-character separators are matched whole", () =>
    Effect.gen(function* () {
      const dialect = { ...StandardDialect, separator: "||" };
      expect(
        (yield* scanCsv("a|b||c\n|||\n", dialect, { treatFirstRowAsHeader: false })).rows,
      ).toEqual([
        ["a|b", "c"],
        ["", "|"],
      ]);
    }),
  );

  it.effect("skipRows counts CRLF, LF and bare CR line endings", () =>
    Effect.gen(function* () {
      expect(yield* scannedRows("junk\rmore\r\na,b\rc,d\r", { skipRows: 2 })).toEqual([
        ["a", "b"],
        ["c", "d"],
      ]);
    }),
  );

  it.effect("trimWhitespace keeps whitespace inside quotes", () =>
    Effect.gen(function* () {
      expect(yield* scannedRows(' " a " , b \n', { trimWhitespace: true })).toEqual([[" a ", "b"]]);
      expect(
        (yield* scanCsv('\t" a "\t\n', TsvDialect, {
          trimWhitespace: true,
          treatFirstRowAsHeader: false,
        })).rows,
      ).toEqual([["", " a ", ""]]);
    }),
  );

  it.effect("providedHeaders replace the header row", () =>
    Effect.gen(function* () {
      const table = yield* scanCsv("h1,h2\n1,2\n", undefined, {
        treatFirstRowAsHeader: true,
        providedHeaders: ["x", "y"],
      });
      expect(table).toEqual({ headers: ["x", "y"], rows: [["1", "2"]] });
    }),
  );

  it.effect("ignores a leading byte order mark", () =>
    Effect.gen(function* () {
      expect(yield* scannedRows("﻿a,b\n")).toEqual([["a", "b"]]);
    }),
  );

  it.effect("accepts LF, CRLF and bare CR line endings", () =>
    Effect.gen(function* () {
      expect(yield* scannedRows("a,b\r\nc,d\re,f\n")).toEqual([
        ["a", "b"],
        ["c", "d"],
        ["e", "f"],
      ]);
    }),
  );

  it.effect("skips blank and comment lines, trims, and skips leading rows", () =>
    Effect.gen(function* () {
      const input = "title line\n# a comment\n  \n a , b \n";
      expect(
        yield* scannedRows(input, { skipRows: 1, lineCommentMarker: "#", trimWhitespace: true }),
      ).toEqual([["a", "b"]]);
      expect(yield* scannedRows("a\n\nb\n", { filterEmpty: false })).toEqual([["a"], [""], ["b"]]);
    }),
  );

  it.effect("uses the dialect separator", () =>
    Effect.gen(function* () {
      expect(
        (yield* scanCsv("a\tb,c\n", TsvDialect, { treatFirstRowAsHeader: false })).rows,
      ).toEqual([["a", "b,c"]]);
    }),
  );

  it.effect("a TSV line of tabs is a row of empty fields, not a blank line (#109)", () =>
    Effect.gen(function* () {
      expect(
        (yield* scanCsv("a\tb\n\t\nc\td\n", TsvDialect, { treatFirstRowAsHeader: false })).rows,
      ).toEqual([
        ["a", "b"],
        ["", ""],
        ["c", "d"],
      ]);
    }),
  );

  it.effect("an unclosed quote fails with its line and column", () =>
    Effect.gen(function* () {
      const r = yield* Effect.result(scanCsv('a,b\nc,"d\ne\n'));
      expect(Result.isFailure(r)).toBe(true);
      assert(Result.isFailure(r));
      expect(r.failure.reason).toContain("closing quote");
      expect(r.failure.position).toEqual({ row: 3, column: 0 });
    }),
  );

  it.effect("rejects rows with the wrong column count", () =>
    Effect.gen(function* () {
      const r = yield* Effect.result(
        scanCsv("a,b\n1\n", undefined, { treatFirstRowAsHeader: true }),
      );
      expect(Result.isFailure(r) && r.failure.position).toEqual({ row: 1 });
    }),
  );

  it.effect("without headers, rows must match the first row's width", () =>
    Effect.gen(function* () {
      const r = yield* Effect.result(scanCsv("a,b\nc\n"));
      expect(Result.isFailure(r) && r.failure.reason).toBe("Row 1 has 1 columns, expected 2");
      expect(yield* scannedRows("a,b\nc\n", { allowVariableColumns: true })).toEqual([
        ["a", "b"],
        ["c"],
      ]);
    }),
  );

  it.effect("column-count errors report the source row", () =>
    Effect.gen(function* () {
      const r = yield* Effect.result(
        scanCsv('# note\n\na,"b\nc"\r\nd\n', undefined, { lineCommentMarker: "#" }),
      );
      expect(Result.isFailure(r) && r.failure.position).toEqual({ row: 4 });
    }),
  );

  it.effect("validating column counts stays linear in the input (#177)", () =>
    Effect.gen(function* () {
      const body = Arr.makeBy(2000, (i) => `${i},x${i},"q ${i}"`).join("\n");
      const csv = `a,b,c\n${body}\nlast,row,here\n`;
      // count every source position read, by the grammar or by a row-position
      // lookup (a counter, not `vi.spyOn`: recording each call's arguments
      // exhausts memory on the quadratic path)
      const charCodeAt = String.prototype.charCodeAt;
      let reads = 0;
      String.prototype.charCodeAt = function (this: string, index: number): number {
        reads++;
        return charCodeAt.call(this, index);
      };
      const table = yield* pipe(
        scanCsv(csv, undefined, { treatFirstRowAsHeader: true }),
        Effect.ensuring(
          Effect.sync(() => {
            String.prototype.charCodeAt = charCodeAt;
          }),
        ),
      );
      expect(table.rows).toHaveLength(2001);
      // linear: a few reads per character (about two today); the quadratic row
      // lookup this guards against made about a thousand
      expect(reads).toBeLessThan(10 * csv.length);
    }),
  );
});

const collect = (chunks: ReadonlyArray<string>, options?: Parameters<typeof scanCsvStream>[2]) =>
  Effect.result(
    Stream.runCollect(
      scanCsvStream(Stream.fromIterable(chunks), undefined, {
        treatFirstRowAsHeader: false,
        ...options,
      }),
    ),
  );

const chunksOf = (source: string, size: number): ReadonlyArray<string> =>
  Arr.makeBy(Math.ceil(source.length / size), (i) => source.slice(i * size, (i + 1) * size));
/** A scan's rows, or its failure's reason and position. */
const outcome = (
  r: Result.Result<ReadonlyArray<ReadonlyArray<string>>, ParseError>,
):
  | { readonly rows: ReadonlyArray<ReadonlyArray<string>> }
  | Pick<ParseError, "reason" | "position"> =>
  Result.match(r, {
    onSuccess: (rows) => ({ rows: [...rows] }),
    onFailure: ({ reason, position }) => ({ reason, position }),
  });
const scanWhole = (source: string, options: Parameters<typeof scanCsv>[2]) =>
  Effect.gen(function* () {
    return yield* Effect.result(Effect.map(scanCsv(source, undefined, options), (t) => t.rows));
  });

/** A scan's rows, or its failure's reason. */
const scanOutcome = (r: Result.Result<ScannedTable, ParseError>) =>
  Result.match(r, {
    onSuccess: (t): Result.Result<ReadonlyArray<ReadonlyArray<string>>, string> =>
      Result.succeed(t.rows),
    onFailure: (e) => Result.fail(e.reason),
  });

const sameRows = Arr.makeEquivalence(Arr.makeEquivalence(Equivalence.String));

/** Whether two scans have the same rows, or fail for the same reason. */
const sameOutcome = (
  a: Result.Result<ReadonlyArray<ReadonlyArray<string>>, string>,
  b: Result.Result<ReadonlyArray<ReadonlyArray<string>>, string>,
): boolean =>
  Result.isSuccess(a) && Result.isSuccess(b)
    ? sameRows(a.success, b.success)
    : Result.isFailure(a) && Result.isFailure(b) && a.failure === b.failure;

describe("CSV scanner fast path", () => {
  // `scanCsv` scans common dialects by hand (src/fast.ts) and anything else
  // with the grammar. `skipRows: 1` after a junk first line forces the
  // grammar on the same rows, so the two must agree: the same rows, or the
  // same failure.
  const dialects: ReadonlyArray<CsvDialect> = [
    StandardDialect,
    TsvDialect,
    { ...StandardDialect, separator: ";" },
    { ...StandardDialect, wrapper: "'", doubleWrapper: "''" },
    { ...StandardDialect, wrapper: "", doubleWrapper: "" },
  ];
  // a Lehmer generator, so the inputs are the same on every run
  let seed = 7;
  const next = (n: number) => {
    seed = (seed * 48271) % 2147483647;
    return seed % n;
  };
  const alphabet = ["a", "b", ",", ";", "\t", '"', "'", "\r", "\n", " ", "\r\n", "é"];
  const samples = [
    ...Arr.makeBy(4000, () =>
      Arr.makeBy(next(24), () => alphabet[next(alphabet.length)] ?? "").join(""),
    ),
    // records about as wide as the widest row literal (src/row.ts), and wider
    ...Arr.makeBy(200, () =>
      Arr.makeBy(3, () => Arr.makeBy(28 + next(8), () => "a").join(",")).join(
        alphabet[7 + next(2)] ?? "\n",
      ),
    ),
  ];
  it.effect.each([true, false])("agrees with the grammar (filterEmpty: %s)", (filterEmpty) =>
    Effect.gen(function* () {
      const options = { allowVariableColumns: true, filterEmpty };
      const disagreements = yield* Effect.forEach(
        dialects.flatMap((dialect) => samples.map((source) => ({ dialect, source }))),
        ({ dialect, source }) =>
          Effect.gen(function* () {
            const fast = scanOutcome(yield* Effect.result(scanCsv(source, dialect, options)));
            const grammar = scanOutcome(
              yield* Effect.result(
                scanCsv(`junk\n${source}`, dialect, { ...options, skipRows: 1 }),
              ),
            );
            return sameOutcome(fast, grammar)
              ? []
              : [{ dialect: dialect.separator + dialect.wrapper, source, fast, grammar }];
          }),
        { concurrency: 1 },
      );
      expect(disagreements.flat().slice(0, 3)).toEqual([]);
    }),
  );

  it.effect("an unclosed quote still fails where the grammar says", () =>
    Effect.gen(function* () {
      const r = yield* Effect.result(scanCsv('a,b\n"open,c\n'));
      // the grammar's position: the end of the input, where the closing quote was due
      expect(Result.isFailure(r) && r.failure.position).toEqual({ row: 2, column: 0 });
      expect(Result.isFailure(r) && r.failure.reason).toContain("Unclosed quoted field");
    }),
  );
});

/** A read's encoded document, or its failure's reason. */
const readOutcome = (options: CsvReaderOptions, csv: string) =>
  Effect.gen(function* () {
    return Result.match(
      yield* Effect.result(
        Effect.flatMap(makeCsvReader(options).read(text(csv)), (doc) => encodeDocument(doc)),
      ),
      {
        onSuccess: (doc) => ({ doc }),
        onFailure: (e) => ({ reason: Predicate.isTagged(e, "ParseError") ? e.reason : e.message }),
      },
    );
  });

/** A general-path outcome with the junk line's offset taken out of its row numbers. */
const unshift = <O extends object>(o: O): O =>
  "reason" in o && Predicate.isString(o.reason)
    ? {
        ...o,
        reason: o.reason.replace(
          /^Row (\d+)/,
          (_match: string, n: string) => `Row ${Number(n) - 1}`,
        ),
      }
    : o;

describe("CSV reader fast path", () => {
  // `read` types rows in one pass (src/fused.ts) when it can, and otherwise
  // takes the general path; `skipRows: 1` after a junk first line forces the
  // general path on the same rows, so the two must give the same document,
  // or the same failure.
  let seed = 19;
  const next = (n: number) => {
    seed = (seed * 48271) % 2147483647;
    return seed % n;
  };
  const pools = [
    ["1", "2.5", "-3", "", "1e2"],
    ["true", "false", ""],
    ["a", "b c", '"q, r"', ""],
    ["1", "2", "x"],
    ["", ""],
    ["true", "1"],
    ["0.14285714285714285", "0.10000000000000001", "12345678901234567890", "1.50000000000000000"],
  ];
  const table = (): string => {
    // now and then a table wider than the widest row literal (src/row.ts)
    const width = next(10) === 0 ? 30 + next(6) : 1 + next(4);
    const columns = Arr.makeBy(width, () => pools[next(pools.length)] ?? []);
    const header = next(2) === 0 ? [columns.map((_, c) => `h${c}`)] : [];
    const rows = Arr.makeBy(next(6), () => {
      const row = columns.map((pool) => pool[next(pool.length)] ?? "");
      // now and then a row of another width
      return next(12) === 0 ? row.slice(1) : row;
    });
    return [...header, ...rows].map((r) => r.join(",")).join(next(2) === 0 ? "\n" : "\r\n");
  };
  const optionSets: ReadonlyArray<CsvReaderOptions> = [
    {},
    { treatFirstRowAsHeader: true },
    { treatFirstRowAsHeader: false },
    { inference: "cell" },
    { inferTypes: false },
    { inferTypes: false, treatFirstRowAsHeader: true },
    { allowVariableColumns: true },
    { allowVariableColumns: true, treatFirstRowAsHeader: true, inference: "cell" },
    { exactNumbers: false },
    { exactNumbers: false, inference: "cell", treatFirstRowAsHeader: false },
  ];
  const decodeJson = Schema.decodeResult(Document);
  const toJson = Schema.encodeSync(Document);
  it.effect(
    "its documents, taken unchecked (worksheetOfTrustedRows), are what the schema accepts",
    () =>
      Effect.gen(function* () {
        // the reader builds its rows unchecked, so a row the schema would reject
        // would pass silently: a decode of each document's encoding checks every
        // cell, on both paths
        const tables = Arr.makeBy(400, table);
        const reads = optionSets.flatMap((options) =>
          tables.flatMap((csv) =>
            [csv, `junk\n${csv}`].map((source, i) => ({
              options: i === 0 ? options : { ...options, skipRows: 1 },
              source,
            })),
          ),
        );
        const docs = (yield* Effect.forEach(
          reads,
          ({ options, source }) =>
            Effect.map(Effect.result(makeCsvReader(options).read(text(source))), (r) =>
              Result.isSuccess(r) ? [r.success] : [],
            ),
          { concurrency: 1 },
        )).flat();
        expect(docs.length).toBeGreaterThan(1000);
        const rejected = docs.filter((doc) => Result.isFailure(decodeJson(toJson(doc))));
        expect(rejected).toEqual([]);
      }),
  );

  it.effect("gives the general path's document or failure", () =>
    Effect.gen(function* () {
      const tables = Arr.makeBy(1500, table);
      const cases = optionSets.flatMap((options) => tables.map((csv) => ({ options, csv })));
      const fast = yield* Effect.forEach(cases, ({ options, csv }) => readOutcome(options, csv), {
        concurrency: 1,
      });
      const general = (yield* Effect.forEach(
        cases,
        ({ options, csv }) => readOutcome({ ...options, skipRows: 1 }, `junk\n${csv}`),
        { concurrency: 1 },
      )).map(unshift);
      expect(fast).toEqual(general);
    }),
  );
});

/** A read's rows as plain values (a blank's `null`, a cell's value), or its failure's reason. */
const readValuesOutcome = (options: CsvReaderOptions, csv: string) =>
  Effect.gen(function* () {
    return Result.match(yield* Effect.result(makeCsvReader(options).read(text(csv))), {
      onSuccess: (doc) => ({
        rows: firstWorksheet(doc).rows.map((r) =>
          cellsOf(r).map((c) => ("value" in c ? c.value : null)),
        ),
      }),
      onFailure: (e) => ({ reason: e.reason }),
    });
  });

/** `readCsvRows`' header and rows as one list of rows, or its failure's reason. */
const rowsOutcome = (options: CsvReaderOptions, csv: string) =>
  Effect.gen(function* () {
    return Result.match(yield* Effect.result(readCsvRows(csv, options)), {
      onSuccess: ({ headers, rows }) => ({ rows: headers === null ? rows : [headers, ...rows] }),
      onFailure: (e) => ({ reason: e.reason }),
    });
  });

/** Four rows of `w` numbers, integers and halves among them. */
const numberRows = (w: number) =>
  Arr.makeBy(4, (r) => Arr.makeBy(w, (c) => (r * 41 + c) / 4 + (c % 2 === 0 ? 0 : 0.5)));

describe("readCsvRows", () => {
  // the scan copies a row by a literal of its width up to 32, and slices a
  // wider one (src/row.ts); rows of numbers have literals of their own
  it.effect.each(Arr.makeBy(40, (i) => i + 1))("copies a row of width %i out of the scan", (w) =>
    Effect.gen(function* () {
      // rows of numbers, then a wider one and a narrower one
      const expected = [
        ...numberRows(w),
        [...Arr.makeBy(w, () => 1.25), 7],
        Arr.makeBy(w - 1, (c) => c + 0.75),
      ].filter(Arr.isArrayNonEmpty);
      const csv = expected.map((row) => row.join(",")).join("\n");
      const options = { treatFirstRowAsHeader: false, allowVariableColumns: true };
      expect((yield* readCsvRows(csv, options)).rows).toEqual(expected);
      const doc = yield* makeCsvReader(options).read(text(csv));
      expect(firstWorksheet(doc).rows.map(rowCellsOf)).toEqual(expected);
      // a CSV document's rows are plain rows (#227)
      expect(firstWorksheet(doc).rows.every(isPlainRow)).toBe(true);
      const words = Arr.makeBy(w, (c) => `w${c}`);
      const scanned = yield* scanCsv(`${words.join(",")}\n${words.join(",")}\n`);
      expect(scanned.rows).toEqual([words, words]);
    }),
  );

  it.effect("reads a header and typed values", () =>
    Effect.gen(function* () {
      expect(yield* readCsvRows("name,age,member\nada,36,true\nbob,,false\n")).toEqual({
        headers: ["name", "age", "member"],
        rows: [
          ["ada", 36, true],
          ["bob", null, false],
        ],
      });
    }),
  );

  it.effect("keeps every value a string with inferTypes off", () =>
    Effect.gen(function* () {
      expect(
        yield* readCsvRows("a,b\n1,\n", { inferTypes: false, treatFirstRowAsHeader: true }),
      ).toEqual({ headers: ["a", "b"], rows: [["1", ""]] });
    }),
  );

  it.effect("types a column as read does: a column with text in it is text", () =>
    Effect.gen(function* () {
      expect(yield* readCsvRows("1\n2\nx\n", { treatFirstRowAsHeader: false })).toEqual({
        headers: null,
        rows: [["1"], ["2"], ["x"]],
      });
      expect(
        yield* readCsvRows("1\n2\nx\n", { treatFirstRowAsHeader: false, inference: "cell" }),
      ).toEqual({ headers: null, rows: [[1], [2], ["x"]] });
    }),
  );

  it.effect("takes provided headers and the reader's null and boolean spellings", () =>
    Effect.gen(function* () {
      expect(
        yield* readCsvRows("1,yes\nNA,no\n", {
          providedHeaders: ["n", "ok"],
          nullValues: ["NA"],
          booleans: ["yes", "no"],
        }),
      ).toEqual({
        headers: ["n", "ok"],
        rows: [
          [1, true],
          [null, false],
        ],
      });
    }),
  );

  it.effect("reads full-precision floats, and keeps text a double cannot hold", () =>
    Effect.gen(function* () {
      const { rows } = yield* readCsvRows(
        "x,y\n0.14285714285714285,1\n0.30000000000000004,12345678901234567890\n",
      );
      expect(rows).toEqual([
        [0.14285714285714285, "1"],
        [0.30000000000000004, "12345678901234567890"],
      ]);
    }),
  );

  it.effect("fails as read does", () =>
    Effect.gen(function* () {
      const r = yield* Effect.result(readCsvRows('a,b\n"open\n'));
      expect(Result.isFailure(r) && r.failure.reason).toContain("Unclosed quoted field");
    }),
  );

  // the same tables and options as the reader's fast-path test, with long decimals among them
  let seed = 23;
  const next = (n: number) => {
    seed = (seed * 48271) % 2147483647;
    return seed % n;
  };
  const pools = [
    ["1", "2.5", "-3", "", "1e2"],
    ["true", "false", ""],
    ["a", "b c", '"q, r"', ""],
    ["1", "2", "x"],
    ["", ""],
    ["true", "1"],
    ["0.14285714285714285", "0.10000000000000001", "-71.42857142857143", ""],
    ["9007199254740993", "12", "1.50"],
  ];
  const table = (): string => {
    // now and then a table wider than the widest row literal (src/row.ts)
    const width = next(10) === 0 ? 30 + next(6) : 1 + next(4);
    const columns = Arr.makeBy(width, () => pools[next(pools.length)] ?? []);
    const header = next(2) === 0 ? [columns.map((_, c) => `h${c}`)] : [];
    const rows = Arr.makeBy(next(6), () => {
      const row = columns.map((pool) => pool[next(pool.length)] ?? "");
      return next(12) === 0 ? row.slice(1) : row;
    });
    return [...header, ...rows].map((r) => r.join(",")).join(next(2) === 0 ? "\n" : "\r\n");
  };
  const optionSets: ReadonlyArray<CsvReaderOptions> = [
    {},
    { treatFirstRowAsHeader: true },
    { treatFirstRowAsHeader: false },
    { inference: "cell" },
    { inferTypes: false },
    { inferTypes: false, treatFirstRowAsHeader: true },
    { allowVariableColumns: true },
    { allowVariableColumns: true, treatFirstRowAsHeader: true, inference: "cell" },
    { providedHeaders: ["p", "q", "r", "s"], allowVariableColumns: true },
    { exactNumbers: false },
    { exactNumbers: false, inference: "cell" },
  ];
  it.effect("gives read's values, by its one-pass path and its general one", () =>
    Effect.gen(function* () {
      const tables = Arr.makeBy(1500, table);
      const cases = optionSets.flatMap((options) => tables.map((csv) => ({ options, csv })));
      const rows = yield* Effect.forEach(cases, ({ options, csv }) => rowsOutcome(options, csv), {
        concurrency: 1,
      });
      expect(rows).toEqual(
        yield* Effect.forEach(cases, ({ options, csv }) => readValuesOutcome(options, csv), {
          concurrency: 1,
        }),
      );
      // `skipRows: 1` after a junk line forces the general path on the same rows
      const general = (yield* Effect.forEach(
        cases,
        ({ options, csv }) => rowsOutcome({ ...options, skipRows: 1 }, `junk\n${csv}`),
        { concurrency: 1 },
      )).map(unshift);
      expect(general).toEqual(rows);
    }),
  );
});

describe("CSV stream scanner", () => {
  it.effect("rows may be split across chunks anywhere", () =>
    Effect.gen(function* () {
      const r = yield* collect(['a,"b', '\n""c"', '""\r', "\nd,e"]);
      expect(Result.isSuccess(r) && [...r.success]).toEqual([
        ["a", 'b\n"c"'],
        ["d", "e"],
      ]);
    }),
  );

  it.effect("emits rows before the stream ends", () =>
    Effect.gen(function* () {
      const first = yield* pipe(
        Stream.concat(Stream.make("a,b\n"), Stream.never),
        (s) => scanCsvStream(s, undefined, { treatFirstRowAsHeader: false }),
        Stream.take(1),
        Stream.runCollect,
      );
      expect([...first]).toEqual([["a", "b"]]);
    }),
  );

  it.effect("skips the header row and validates column counts", () =>
    Effect.gen(function* () {
      const ok = yield* collect(["h1,h2\n1,", "2\n"], { treatFirstRowAsHeader: true });
      expect(Result.isSuccess(ok) && [...ok.success]).toEqual([["1", "2"]]);
      const bad = yield* collect(["h1,h2\n1\n"], { treatFirstRowAsHeader: true });
      expect(Result.isFailure(bad) && bad.failure._tag).toBe("ParseError");
    }),
  );

  it.effect("emits the rows before a bad one, then fails at it, within one chunk", () =>
    Effect.gen(function* () {
      const seen: Array<ReadonlyArray<string>> = [];
      const r = yield* Effect.result(
        Stream.runForEach(
          scanCsvStream(Stream.make("h1,h2\n1,2\n3,4\n5\n6,7\n"), undefined, {
            treatFirstRowAsHeader: true,
          }),
          (row) => Effect.sync(() => seen.push(row)),
        ),
      );
      expect(seen).toEqual([
        ["1", "2"],
        ["3", "4"],
      ]);
      expect(Result.isFailure(r) && r.failure.reason).toBe("Row 3 has 1 columns, expected 2");
    }),
  );

  it.effect("a stream failing its header check emits nothing", () =>
    Effect.gen(function* () {
      const r = yield* collect(["a,a\n1,2\n"], {
        treatFirstRowAsHeader: true,
        validateHeaders: true,
      });
      expect(outcome(r)).toEqual({
        reason: 'Header "a" appears in columns 1 and 2',
        position: { row: 0, column: 1 },
      });
    }),
  );

  it.effect("skipRows drops physical lines across chunk boundaries", () =>
    Effect.gen(function* () {
      const r = yield* collect(["junk", " line\nmore\na,b\n"], { skipRows: 2 });
      expect(Result.isSuccess(r) && [...r.success]).toEqual([["a", "b"]]);
    }),
  );

  it.effect("skipRows counts bare CR and CRLF split across chunks", () =>
    Effect.gen(function* () {
      const r = yield* collect(["junk\r", "\nmore\r", "a,b\r", "\nc,d\n"], { skipRows: 2 });
      expect(Result.isSuccess(r) && [...r.success]).toEqual([
        ["a", "b"],
        ["c", "d"],
      ]);
    }),
  );

  it.effect("syntax errors carry their source position", () =>
    Effect.gen(function* () {
      const r = yield* collect(["x\n", "a,b\nc,", '"d\ne\n'], { skipRows: 1 });
      expect(Result.isFailure(r) && r.failure.reason).toBe(
        "Unclosed quoted field: expected a closing quote",
      );
      expect(Result.isFailure(r) && r.failure.position).toEqual({ row: 4, column: 0 });
    }),
  );

  it.effect("column-count errors report the source row", () =>
    Effect.gen(function* () {
      const r = yield* collect(['a,"b\nc"\n\n', "d\n"]);
      expect(Result.isFailure(r) && r.failure.position).toEqual({ row: 3 });
    }),
  );

  it.effect("providedHeaders replace the header row and set the width", () =>
    Effect.gen(function* () {
      const r = yield* collect(["h\n1,2\n"], {
        treatFirstRowAsHeader: true,
        providedHeaders: ["x", "y"],
      });
      expect(Result.isSuccess(r) && [...r.success]).toEqual([["1", "2"]]);
    }),
  );

  it.effect("the compiled row grammar agrees with the whole-text scan at every chunk size", () =>
    Effect.gen(function* () {
      const source = ' a , "b ""q"" \r\nc" ,d\n# note\n\n e,"f",g \r1,"x\ny",3\n';
      const optionSets = [
        {},
        { trimWhitespace: true, lineCommentMarker: "#" },
        { filterEmpty: false, allowVariableColumns: true, quoteAnywhere: true },
      ];
      // sizes repeat: a later run reuses the memoized compiled parser
      const sizes = [1, 2, 3, 7, source.length, 1, source.length];
      const pairs = yield* Effect.forEach(
        optionSets.flatMap((options) => sizes.map((size) => ({ options, size }))),
        ({ options, size }) =>
          Effect.gen(function* () {
            return {
              whole: outcome(yield* scanWhole(source, options)),
              streamed: outcome(yield* collect(chunksOf(source, size), options)),
            };
          }),
        { concurrency: "unbounded" },
      );
      expect(pairs.map((p) => p.streamed)).toEqual(pairs.map((p) => p.whole));
    }),
  );

  it.effect("a syntax error matches the whole-text scan at every chunk size", () =>
    Effect.gen(function* () {
      const source = 'a,b\nc,"d\ne,f\n';
      const whole = outcome(yield* scanWhole(source, undefined));
      expect(whole).toHaveProperty("reason", "Unclosed quoted field: expected a closing quote");
      const streamed = yield* Effect.forEach(
        [1, 2, 5, 64],
        (size) => Effect.map(collect(chunksOf(source, size)), outcome),
        { concurrency: "unbounded" },
      );
      expect(streamed).toEqual([whole, whole, whole, whole]);
    }),
  );

  it.effect("ignores a leading byte order mark", () =>
    Effect.gen(function* () {
      const r = yield* collect(["", "﻿a,b\n"]);
      expect(Result.isSuccess(r) && [...r.success]).toEqual([["a", "b"]]);
    }),
  );
});

const sheet = (rows: ReadonlyArray<ReadonlyArray<SheetCell>>) =>
  trustAs<CsvFeature>(document([worksheet("Sheet1", rows)]));
const written = (rows: ReadonlyArray<ReadonlyArray<SheetCell>>, options?: CsvWriterOptions) =>
  Effect.gen(function* () {
    const out = yield* makeCsvWriter(options).write(sheet(rows));
    return Predicate.isTagged(out, "Text") ? out.text : "";
  });

/** The reason the CSV writer fails `rows` under `options`, if it fails. */
const failure = (rows: ReadonlyArray<ReadonlyArray<SheetCell>>, options: CsvWriterOptions) =>
  Effect.gen(function* () {
    const r = yield* Effect.result(makeCsvWriter(options).write(sheet(rows)));
    return Result.isFailure(r) ? r.failure.reason : undefined;
  });

describe("CSV writer", () => {
  it.effect("round-trips through reader -> writer", () =>
    Effect.gen(function* () {
      const input = "product,price\nLaptop,999.99\nMouse,24.99\n";
      const doc = yield* makeCsvReader().read(text(input));
      const out = yield* makeCsvWriter().write(doc);
      expect(out._tag).toBe("Text");
      assert(Predicate.isTagged(out, "Text"));
      expect(out.text).toBe(input);
    }),
  );

  it.effect("round-trips fields containing quotes and line breaks", () =>
    Effect.gen(function* () {
      const doc = document([worksheet("Sheet1", [[cell.text('say "hi"\nthere'), cell.text("x")]])]);
      const out = yield* makeCsvWriter().write(trustAs<CsvFeature>(doc));
      const back = yield* makeCsvReader().read(out);
      expect(cellsOf(firstWorksheet(back).rows[0]!)).toEqual([
        cell.text('say "hi"\nthere'),
        cell.text("x"),
      ]);
    }),
  );

  it.effect("writes a sparse worksheet's gaps as empty fields and empty lines (#185)", () =>
    Effect.gen(function* () {
      const ws = new Worksheet({
        name: "S",
        columns: [],
        rows: [
          new SheetRow({ index: 0, cells: [undefined, undefined, cell.text("c")] }),
          new SheetRow({ index: 2, cells: [cell.number(1)] }),
        ],
        merges: [],
      });
      const out = yield* makeCsvWriter().write(trustAs<CsvFeature>(document([ws])));
      assert(Predicate.isTagged(out, "Text"));
      expect(out.text).toBe(",,c\n\n1\n");
      const padded = yield* makeCsvWriter({ padRows: true }).write(
        trustAs<CsvFeature>(document([ws])),
      );
      assert(Predicate.isTagged(padded, "Text"));
      expect(padded.text).toBe(",,c\n,,\n1,,\n");
    }),
  );

  it.effect("a worksheet whose gaps expand past maxFields fails before rendering (#185)", () =>
    Effect.gen(function* () {
      const far = new Worksheet({
        name: "Far",
        columns: [],
        rows: [sparseRow(1_048_575, [[16_383, cell.text("z")]])],
        merges: [],
      });
      // ragged: a million empty lines and 16 384 fields fit the default budget
      const error = yield* Effect.flip(
        makeCsvWriter({ maxFields: 1_000_000 }).write(trustAs<CsvFeature>(document([far]))),
      );
      expect(error).toMatchObject({ _tag: "WriteError", format: "csv" });
      expect(error.reason).toContain("maxFields");
      // padded to a rectangle it is 17 billion fields, past the default
      const padded = yield* Effect.flip(
        makeCsvWriter({ padRows: true }).write(trustAs<CsvFeature>(document([far]))),
      );
      expect(padded.reason).toContain("maxFields");
    }),
  );

  it.effect("a streamed row wider than maxFields fails the stream (#185)", () =>
    Effect.gen(function* () {
      const wide = sparseRow(0, [[20, cell.text("z")]]);
      const result = yield* Effect.result(
        Stream.runCollect(renderCsvStream(Stream.make(wide), { maxFields: 10 })),
      );
      assert(Result.isFailure(result));
      expect(result.failure).toMatchObject({ _tag: "WriteError" });
    }),
  );

  it.effect("quotes fields containing the separator", () =>
    Effect.gen(function* () {
      const doc = yield* makeCsvReader().read(text('a,"b,c"\n'));
      const out = yield* makeCsvWriter().write(doc);
      assert(Predicate.isTagged(out, "Text"));
      expect(out.text).toBe('a,"b,c"\n');
    }),
  );

  it.effect("keeps rows holding a single blank cell", () =>
    Effect.gen(function* () {
      const rows = ["a", "", "b", "", "c"].map((v) => [v === "" ? cell.blank() : cell.text(v)]);
      const out = yield* written(rows);
      expect(out).toBe('a\n""\nb\n""\nc\n');
      expect(firstWorksheet(yield* makeCsvReader().read(text(out))).rows).toHaveLength(5);
      expect(renderTable([["a"], [""]])).toBe('a\n""\n');
    }),
  );

  it.effect("writes NaN and the infinities as text, as pandas does (#89)", () =>
    Effect.gen(function* () {
      expect([Number.NaN, Infinity, -Infinity].map(formatCsvNumber)).toEqual([
        "NaN",
        "Infinity",
        "-Infinity",
      ]);
      const out = yield* written([
        [cell.number(Number.NaN), cell.number(Infinity), cell.number(-Infinity)],
      ]);
      expect(out).toBe("NaN,Infinity,-Infinity\n");
      // they read back as text: the strict number grammar never accepts them
      expect(firstWorksheet(yield* makeCsvReader().read(text(out))).rows.map(cellsOf)[0]).toEqual([
        cell.text("NaN"),
        cell.text("Infinity"),
        cell.text("-Infinity"),
      ]);
    }),
  );

  it.effect("writes numbers as shortest round-trip decimals", () =>
    Effect.gen(function* () {
      expect([1e21, -1.5e-7, 0.1, 123.456, -0, 2 ** 70].map(formatCsvNumber)).toEqual([
        "1000000000000000000000",
        "-0.00000015",
        "0.1",
        "123.456",
        "0",
        "1180591620717411300000",
      ]);
      expect(yield* written([[cell.number(1e21)]])).toBe("1000000000000000000000\n");
      expect(yield* written([[cell.number(1.5)]], { formatNumber: (n) => n.toFixed(2) })).toBe(
        "1.50\n",
      );
    }),
  );

  it.effect("quotes fields with edge whitespace or a leading comment marker", () =>
    Effect.gen(function* () {
      const row = [cell.text(" a"), cell.text("b "), cell.text("#c"), cell.text("d#")];
      expect(yield* written([row])).toBe('" a","b ",#c,d#\n');
      expect(yield* written([row], { lineCommentMarker: "#" })).toBe('" a","b ","#c",d#\n');
    }),
  );

  it.effect("escapeFormulae prefixes and quotes formula-like text", () =>
    Effect.gen(function* () {
      const row = [
        cell.text('=HYPERLINK("x")'),
        cell.text("+1"),
        cell.text("-a"),
        cell.text("@b"),
        cell.text("\tc"),
        cell.number(-1),
        cell.text("ok"),
      ];
      expect(yield* written([row])).toBe('"=HYPERLINK(""x"")",+1,-a,@b,"\tc",-1,ok\n');
      expect(yield* written([row], { escapeFormulae: true })).toBe(
        `"'=HYPERLINK(""x"")","'+1","'-a","'@b","'\tc",-1,ok\n`,
      );
    }),
  );

  it.effect("quoting modes", () =>
    Effect.gen(function* () {
      const row = [cell.text("a"), cell.number(1), cell.boolean(true), cell.blank()];
      expect(yield* written([row], { quoting: "all" })).toBe('"a","1","true",""\n');
      expect(yield* written([row], { quoting: "nonNumeric" })).toBe('"a",1,"true",""\n');
      expect(yield* written([row], { quoting: "none" })).toBe("a,1,true,\n");
      const r = yield* Effect.result(
        makeCsvWriter({ quoting: "none" }).write(sheet([[cell.text("a,b")]])),
      );
      expect(Result.isFailure(r) && r.failure.reason).toBe(
        "Row 0 has a field that needs quotes and cannot be written without quoting",
      );
    }),
  );

  it.effect("escapeChar escapes the wrapper instead of doubling it (#89)", () =>
    Effect.gen(function* () {
      const row = [cell.text('say "hi"'), cell.text("plain"), cell.number(1)];
      expect(yield* written([row], { escapeChar: "\\" })).toBe('"say \\"hi\\"",plain,1\n');
      expect(yield* written([row], { escapeChar: "\\", quoting: "all" })).toBe(
        '"say \\"hi\\"","plain","1"\n',
      );
      // a reader that takes `\"` for a wrapper reads every field back as written
      const tricky = [cell.text('"'), cell.text('a"",b'), cell.text('x"\ny'), cell.text("z")];
      const out = yield* written([tricky], { escapeChar: "\\" });
      const back = yield* makeCsvReader({
        dialect: { ...StandardDialect, doubleWrapper: '\\"' },
        inferTypes: false,
      }).read(text(out));
      expect(firstWorksheet(back).rows).toHaveLength(1);
      expect(cellsOf(firstWorksheet(back).rows[0]!)).toEqual(tricky);
    }),
  );

  it.effect("escapeChar fails on a field holding the escape character (#89)", () =>
    Effect.gen(function* () {
      // `x\` would close as `"x\"`, which an escape-aware reader leaves unclosed
      const values = ["x\\", 'a\\"b', "C:\\tmp"];
      const reasons = yield* Effect.forEach(
        values,
        (value) => failure([[cell.text(value)]], { escapeChar: "\\" }),
        { concurrency: "unbounded" },
      );
      expect(reasons).toEqual(
        values.map(
          () =>
            "Row 0 has a field holding the escape character, which cannot be written unambiguously",
        ),
      );
    }),
  );

  it.effect("escapeChar does not let quoting none write separators or line breaks (#89)", () =>
    Effect.gen(function* () {
      // escaped in place, `a\,=cmd()` would be a new `=cmd()` cell to a naive reader
      const options: CsvWriterOptions = { escapeChar: "\\", quoting: "none", escapeFormulae: true };
      const values = ["a,=cmd()", "a\n=cmd()", 'a"b'];
      const reasons = yield* Effect.forEach(
        values,
        (value) => failure([[cell.text(value), cell.text("z")]], options),
        { concurrency: "unbounded" },
      );
      expect(reasons).toEqual(
        values.map(
          () => "Row 0 has a field that needs quotes and cannot be written without quoting",
        ),
      );
      expect(yield* failure([[cell.blank()]], options)).toBe(
        "Row 0 is a single empty field and cannot be written without quoting",
      );
    }),
  );

  it.effect("escapeChar must be one character other than the separator or wrapper (#89)", () =>
    Effect.gen(function* () {
      const results = yield* Effect.forEach(
        ["", "\\\\", ",", '"', "\n"],
        (escapeChar) =>
          Effect.result(makeCsvWriter({ escapeChar }).write(sheet([[cell.text("a")]]))),
        { concurrency: 1 },
      );
      expect(results.map(Result.isFailure)).toEqual([true, true, true, true, true]);
      const streamed = yield* Effect.result(
        Stream.runCollect(
          renderCsvStream(Stream.make(sheetRow(0, [cell.text("a")])), {
            escapeChar: ",",
          }),
        ),
      );
      expect(Result.isFailure(streamed) && streamed.failure.reason).toBe(
        "escapeChar must differ from the separator, the wrapper and line breaks",
      );
    }),
  );

  it.effect("line breaks come from the dialect", () =>
    Effect.gen(function* () {
      expect(
        yield* written([[cell.text("a")], [cell.text("b")]], { dialect: Rfc4180Dialect }),
      ).toBe("a\r\nb\r\n");
    }),
  );

  it.effect("bom, headers and padRows", () =>
    Effect.gen(function* () {
      const rows = [[cell.text("a")], [cell.text("b"), cell.text("c"), cell.text("d")]];
      expect(yield* written(rows, { bom: true, headers: ["x", "y"], padRows: true })).toBe(
        "﻿x,y,\na,,\nb,c,d\n",
      );
      expect(yield* written([], { headers: ["x"] })).toBe("x\n");
    }),
  );

  it.effect("pads a sheet of many rows without overflowing the stack", () =>
    Effect.gen(function* () {
      const rows = Array.from({ length: 300_000 }, (_, i) => [cell.number(i)]);
      const out = yield* makeCsvWriter({ padRows: true }).write(
        trustAs<CsvFeature>(document([worksheet("S", rows)])),
      );
      expect(Predicate.isTagged(out, "Text") && out.text.split("\n").length).toBe(300_001);
    }),
  );

  test("renderField quotes only a field that needs it, as the minimal mode does", () => {
    expect(
      ["plain", "a,b", 'say "hi"', "two\nlines", "cr\r", " edge", "edge\u00a0", ""].map((f) =>
        renderField(f, StandardDialect),
      ),
    ).toEqual([
      "plain",
      '"a,b"',
      '"say ""hi"""',
      '"two\nlines"',
      '"cr\r"',
      '" edge"',
      '"edge\u00a0"',
      "",
    ]);
    expect(renderField("a\tb", TsvDialect)).toBe('"a\tb"');
    expect(renderField("a\tb", StandardDialect)).toBe("a\tb");
  });

  it.effect("renderCsvStream emits a chunk per row", () =>
    Effect.gen(function* () {
      const rows = [[cell.text("a"), cell.number(1e21)], [cell.blank()], [cell.text("b,c")]];
      const options: CsvWriterOptions = { headers: ["x", "y"], padRows: true, bom: true };
      const chunks = yield* Stream.runCollect(
        renderCsvStream(Stream.fromIterable(rows.map((cells, i) => sheetRow(i, cells))), options),
      );
      expect([...chunks]).toEqual(["﻿", "x,y\n", "a,1000000000000000000000\n", ",\n", '"b,c",\n']);
      expect([...chunks].join("")).toBe(yield* written(rows, options));
    }),
  );
});

describe("synthesizeDocument", () => {
  it.effect("is reproducible with a seed and conforms to CSV", () =>
    Effect.gen(function* () {
      const a = yield* synthesizeDocument({ columns: ["x", "y"], quantity: 5, seed: 42 });
      const b = yield* synthesizeDocument({ columns: ["x", "y"], quantity: 5, seed: 42 });
      expect(a).toEqual(b);
      const ws = firstWorksheet(a);
      expect(ws.rows).toHaveLength(6); // header + 5
    }),
  );
});

const scan = (input: string, options: Parameters<typeof scanCsv>[2]) =>
  Effect.result(scanCsv(input, undefined, options));
const stream = (input: string, options: Parameters<typeof scanCsvStream>[2]) =>
  Effect.result(Stream.runCollect(scanCsvStream(Stream.make(input), undefined, options)));

describe("validateHeaders (#87)", () => {
  it.effect("is off by default: duplicate and empty names are kept", () =>
    Effect.gen(function* () {
      const r = yield* scan(",a,a\n1,2,3\n", { treatFirstRowAsHeader: true });
      expect(Result.isSuccess(r) && r.success.headers).toEqual(["", "a", "a"]);
    }),
  );

  it.effect("rejects an empty or whitespace-only name with its column", () =>
    Effect.gen(function* () {
      const first = yield* scan(",a,b\n1,2,3\n", {
        treatFirstRowAsHeader: true,
        validateHeaders: true,
      });
      assert(Result.isFailure(first));
      expect(first.failure.reason).toBe("Header 1 is empty");
      expect(first.failure.position).toEqual({ row: 0, column: 0 });
      const blank = yield* scan("a, ,b\n1,2,3\n", {
        treatFirstRowAsHeader: true,
        validateHeaders: true,
      });
      assert(Result.isFailure(blank));
      expect(blank.failure.reason).toBe("Header 2 is empty");
    }),
  );

  it.effect("rejects a repeated name, naming both columns", () =>
    Effect.gen(function* () {
      const r = yield* scan("a,b,a\n1,2,3\n", {
        treatFirstRowAsHeader: true,
        validateHeaders: true,
      });
      assert(Result.isFailure(r));
      expect(r.failure.reason).toBe('Header "a" appears in columns 1 and 3');
      expect(r.failure.position).toEqual({ row: 0, column: 2 });
    }),
  );

  it.effect("checks providedHeaders too, and passes valid headers through", () =>
    Effect.gen(function* () {
      const bad = yield* scan("1,2\n", { providedHeaders: ["x", "x"], validateHeaders: true });
      assert(Result.isFailure(bad));
      expect(bad.failure.position?.row).toBeUndefined();
      const good = yield* scan("a,b\n1,2\n", {
        treatFirstRowAsHeader: true,
        validateHeaders: true,
      });
      expect(Result.isSuccess(good) && good.success.headers).toEqual(["a", "b"]);
    }),
  );

  it.effect("the stream scanner applies the same check", () =>
    Effect.gen(function* () {
      const fromRow = yield* stream("a,a\n1,2\n", {
        treatFirstRowAsHeader: true,
        validateHeaders: true,
      });
      assert(Result.isFailure(fromRow));
      expect(fromRow.failure.reason).toBe('Header "a" appears in columns 1 and 2');
      const provided = yield* stream("1,2\n", {
        providedHeaders: ["", "y"],
        validateHeaders: true,
      });
      assert(Result.isFailure(provided));
      expect(provided.failure.reason).toBe("Header 1 is empty");
      const ok = yield* stream("a,b\n1,2\n", {
        treatFirstRowAsHeader: true,
        validateHeaders: true,
      });
      expect(Result.isSuccess(ok) && [...ok.success]).toEqual([["1", "2"]]);
    }),
  );
});
