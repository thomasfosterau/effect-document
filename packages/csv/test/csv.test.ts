import * as Arr from "effect/Array";
import * as Predicate from "effect/Predicate";
import { assert, describe, expect, test } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import { pipe } from "effect/Function";
import {
  cell,
  document,
  type ParseError,
  type SheetCell,
  SheetRow,
  text,
  Worksheet,
  worksheet,
} from "@thomasfosterau/effect-document";
import {
  type CsvReaderOptions,
  type CsvWriterOptions,
  Rfc4180Dialect,
  StandardDialect,
  TsvDialect,
  formatCsvNumber,
  inferCell,
  makeCsvReader,
  makeCsvWriter,
  renderCsvStream,
  renderTable,
  scanCsv,
  scanCsvStream,
  synthesizeDocument,
} from "../src/index.ts";

const run = <A, E>(e: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(e);

const firstWorksheet = (doc: { blocks: ReadonlyArray<{ _tag: string }> }): Worksheet =>
  doc.blocks.find((b) => Predicate.isTagged(b, "Worksheet")) as Worksheet;

describe("CSV reader", () => {
  test("infers number/boolean/blank cells", async () => {
    const doc = await run(
      makeCsvReader({ treatFirstRowAsHeader: false }).read(text("alice,30,true\nbob,,false\n")),
    );
    const ws = firstWorksheet(doc);
    expect(ws.rows[0]!.cells.map((c) => c._tag)).toEqual(["CellText", "CellNumber", "CellBoolean"]);
    expect(ws.rows[1]!.cells[1]!._tag).toBe("CellBlank");
  });

  test("inferTypes: false keeps every value as text", async () => {
    const doc = await run(makeCsvReader({ inferTypes: false }).read(text("1,true\n")));
    const ws = firstWorksheet(doc);
    expect(ws.rows[0]!.cells.every((c) => Predicate.isTagged(c, "CellText"))).toBe(true);
  });

  test("header row is read as text cells", async () => {
    const doc = await run(
      makeCsvReader({ treatFirstRowAsHeader: true }).read(text("name,age\nalice,30\n")),
    );
    const ws = firstWorksheet(doc);
    expect(ws.rows[0]!.cells.map((c) => c._tag)).toEqual(["CellText", "CellText"]);
    expect(ws.rows[1]!.cells[1]).toMatchObject({ _tag: "CellNumber", value: 30 });
  });

  test("produces a document conforming to the CSV profile", async () => {
    const reader = makeCsvReader();
    const doc = await run(reader.read(text("a,1\nb,2\n")));
    expect(reader.profile.is(doc)).toBe(true);
  });

  // value-by-value inference on headerless input, unless a test says otherwise
  const cells = async (input: string, options?: CsvReaderOptions) =>
    firstWorksheet(
      await run(
        makeCsvReader({ treatFirstRowAsHeader: false, inference: "cell", ...options }).read(
          text(input),
        ),
      ),
    ).rows.map((r) => r.cells.map((c) => ("value" in c ? c.value : null)));

  test("reads only plain decimals as numbers", async () => {
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
    expect((await cells(values.join(",")))[0]).toEqual([
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
  });

  test("keeps a value a number only when a double holds its digits (#88)", async () => {
    const values = ["0.30000000000000004", "9007199254740992", "9007199254740993", "1e400", "7.10"];
    expect((await cells(values.join(",")))[0]).toEqual([
      0.30000000000000004,
      9007199254740992,
      "9007199254740993",
      "1e400",
      7.1,
    ]);
  });

  test("booleans are case-insensitive and configurable", async () => {
    expect(await cells("TRUE,False,yes\n")).toEqual([[true, false, "yes"]]);
    expect(await cells("TRUE,true\n", { booleansCaseSensitive: true })).toEqual([["TRUE", true]]);
    expect(await cells("yes,NO,true\n", { booleans: ["yes", "no"] })).toEqual([
      [true, false, "true"],
    ]);
    expect(await cells("true\n", { booleans: false })).toEqual([["true"]]);
  });

  test("decimalChar, groupChar and percent", async () => {
    const options: CsvReaderOptions = {
      dialect: { ...TsvDialect },
      decimalChar: ",",
      groupChar: ".",
      percent: true,
    };
    expect(await cells("1.234,56\t1234,5\t12%\t7%\t1.23,4\t12,34.5\n", options)).toEqual([
      [1234.56, 1234.5, 0.12, 0.07, "1.23,4", "12,34.5"],
    ]);
    expect(await cells('"1,234.56",12%\n', { groupChar: "," })).toEqual([[1234.56, "12%"]]);
  });

  test("nullValues become blank cells", async () => {
    const doc = await run(
      makeCsvReader({ nullValues: ["", "NA", "NULL"], treatFirstRowAsHeader: false }).read(
        text("NA,NULL,,na\n"),
      ),
    );
    expect(firstWorksheet(doc).rows[0]!.cells.map((c) => c._tag)).toEqual([
      "CellBlank",
      "CellBlank",
      "CellBlank",
      "CellText",
    ]);
  });

  test("column inference types a column by all its values", async () => {
    const input = "1,true,a,1\n2,false,,x\n,TRUE,b,3\n";
    expect(await cells(input, { inference: "column" })).toEqual([
      [1, true, "a", "1"],
      [2, false, null, "x"],
      [null, true, "b", "3"],
    ]);
    expect(await cells(input, { inference: "cell" })).toEqual([
      [1, true, "a", 1],
      [2, false, null, "x"],
      [null, true, "b", 3],
    ]);
    // the header row is excluded from inference
    expect(
      await cells("id,ok\n1,true\n", { inference: "column", treatFirstRowAsHeader: true }),
    ).toEqual([
      ["id", "ok"],
      [1, true],
    ]);
  });

  test("by default the header row is sniffed and each column is typed as a whole (#88)", async () => {
    const values = (options?: CsvReaderOptions) =>
      run(makeCsvReader(options).read(text("id,code,n\n1,007,2.5\n2,8,3\n"))).then((doc) =>
        firstWorksheet(doc).rows.map((r) => r.cells.map((c) => ("value" in c ? c.value : null))),
      );
    const expected = [
      ["id", "code", "n"],
      // `007` keeps the whole code column text, so `8` stays as written too
      [1, "007", 2.5],
      [2, "8", 3],
    ];
    expect(await values()).toEqual(expected);
    // an optional forwarded as `undefined` still means the default
    expect(await values({ treatFirstRowAsHeader: undefined, inference: undefined })).toEqual(
      expected,
    );
    expect(await values({ inference: "cell" })).toEqual([
      ["id", "code", "n"],
      [1, "007", 2.5],
      [2, 8, 3],
    ]);
    expect((await values({ treatFirstRowAsHeader: false }))[1]).toEqual(["1", "007", "2.5"]);
  });

  test("header sniffing: a typed first row is data, an all-text file has no header (#88)", async () => {
    const values = async (input: string, options?: CsvReaderOptions) =>
      firstWorksheet(await run(makeCsvReader(options).read(text(input)))).rows.map((r) =>
        r.cells.map((c) => ("value" in c ? c.value : null)),
      );
    // no text first row: headerless numbers
    expect(await values("1,2\n3,4\n")).toEqual([
      [1, 2],
      [3, 4],
    ]);
    // every column text: nothing tells a header apart, so the first row is data
    expect(await values("name,city\nalice,paris\n")).toEqual([
      ["name", "city"],
      ["alice", "paris"],
    ]);
    // a blank in the first row: not a header, so the numbers make that column text
    expect(await values("id,\n1,2\n")).toEqual([
      ["id", null],
      ["1", 2],
    ]);
    // one row: no data to compare against
    expect(await values("a,b\n")).toEqual([["a", "b"]]);
    // an explicit setting overrides the sniff either way
    expect(await values("1,2\n3,4\n", { treatFirstRowAsHeader: true })).toEqual([
      ["1", "2"],
      [3, 4],
    ]);
    expect(await values("id,n\n1,2\n", { treatFirstRowAsHeader: false })).toEqual([
      ["id", "n"],
      ["1", "2"],
    ]);
  });

  test("readStream yields rows", async () => {
    const rows = await run(
      pipe(
        makeCsvReader({ treatFirstRowAsHeader: false }).readStream!(text("a,b\nc,d\n")),
        Stream.runCollect,
      ),
    );
    expect([...rows]).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
  });
});

describe("CSV scanner", () => {
  // the grammar under test, on headerless input unless a test says otherwise
  const rows = (input: string, options?: Parameters<typeof scanCsv>[2]) =>
    Effect.runSync(scanCsv(input, undefined, { treatFirstRowAsHeader: false, ...options })).rows;

  test("quoted fields may contain separators, doubled quotes and line breaks", () => {
    expect(rows('a,"b,""c""\nd"\ne,f')).toEqual([
      ["a", 'b,"c"\nd'],
      ["e", "f"],
    ]);
  });

  test("a wrapper inside an unquoted field is literal", () => {
    expect(rows('12" pizza,3\n6" sub,2\n')).toEqual([
      ['12" pizza', "3"],
      ['6" sub', "2"],
    ]);
    expect(rows('"a"b,c')).toEqual([["ab", "c"]]);
  });

  test("quoteAnywhere: quoted and unquoted segments mix within a field", () => {
    expect(rows('x"y,z"w,""', { quoteAnywhere: true })).toEqual([["xy,zw", ""]]);
  });

  test("an empty wrapper turns quoting off", () => {
    const dialect = { ...StandardDialect, wrapper: "", doubleWrapper: "" };
    expect(
      Effect.runSync(scanCsv('"a,b"\n', dialect, { treatFirstRowAsHeader: false })).rows,
    ).toEqual([['"a', 'b"']]);
  });

  test("multi-character separators are matched whole", () => {
    const dialect = { ...StandardDialect, separator: "||" };
    expect(
      Effect.runSync(scanCsv("a|b||c\n|||\n", dialect, { treatFirstRowAsHeader: false })).rows,
    ).toEqual([
      ["a|b", "c"],
      ["", "|"],
    ]);
  });

  test("skipRows counts CRLF, LF and bare CR line endings", () => {
    expect(rows("junk\rmore\r\na,b\rc,d\r", { skipRows: 2 })).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
  });

  test("trimWhitespace keeps whitespace inside quotes", () => {
    expect(rows(' " a " , b \n', { trimWhitespace: true })).toEqual([[" a ", "b"]]);
    expect(
      Effect.runSync(
        scanCsv('\t" a "\t\n', TsvDialect, { trimWhitespace: true, treatFirstRowAsHeader: false }),
      ).rows,
    ).toEqual([["", " a ", ""]]);
  });

  test("providedHeaders replace the header row", () => {
    const table = Effect.runSync(
      scanCsv("h1,h2\n1,2\n", undefined, {
        treatFirstRowAsHeader: true,
        providedHeaders: ["x", "y"],
      }),
    );
    expect(table).toEqual({ headers: ["x", "y"], rows: [["1", "2"]] });
  });

  test("ignores a leading byte order mark", () => {
    expect(rows("﻿a,b\n")).toEqual([["a", "b"]]);
  });

  test("accepts LF, CRLF and bare CR line endings", () => {
    expect(rows("a,b\r\nc,d\re,f\n")).toEqual([
      ["a", "b"],
      ["c", "d"],
      ["e", "f"],
    ]);
  });

  test("skips blank and comment lines, trims, and skips leading rows", () => {
    const input = "title line\n# a comment\n  \n a , b \n";
    expect(rows(input, { skipRows: 1, lineCommentMarker: "#", trimWhitespace: true })).toEqual([
      ["a", "b"],
    ]);
    expect(rows("a\n\nb\n", { filterEmpty: false })).toEqual([["a"], [""], ["b"]]);
  });

  test("uses the dialect separator", () => {
    expect(
      Effect.runSync(scanCsv("a\tb,c\n", TsvDialect, { treatFirstRowAsHeader: false })).rows,
    ).toEqual([["a", "b,c"]]);
  });

  test("an unclosed quote fails with its line and column", () => {
    const r = Effect.runSync(Effect.result(scanCsv('a,b\nc,"d\ne\n')));
    expect(Result.isFailure(r)).toBe(true);
    assert(Result.isFailure(r));
    expect(r.failure.reason).toContain("closing quote");
    expect(r.failure.position).toEqual({ row: 3, column: 0 });
  });

  test("rejects rows with the wrong column count", () => {
    const r = Effect.runSync(
      Effect.result(scanCsv("a,b\n1\n", undefined, { treatFirstRowAsHeader: true })),
    );
    expect(Result.isFailure(r) && r.failure.position).toEqual({ row: 1 });
  });

  test("without headers, rows must match the first row's width", () => {
    const r = Effect.runSync(Effect.result(scanCsv("a,b\nc\n")));
    expect(Result.isFailure(r) && r.failure.reason).toBe("Row 1 has 1 columns, expected 2");
    expect(rows("a,b\nc\n", { allowVariableColumns: true })).toEqual([["a", "b"], ["c"]]);
  });

  test("column-count errors report the source row", () => {
    const r = Effect.runSync(
      Effect.result(scanCsv('# note\n\na,"b\nc"\r\nd\n', undefined, { lineCommentMarker: "#" })),
    );
    expect(Result.isFailure(r) && r.failure.position).toEqual({ row: 4 });
  });

  test("validating column counts stays linear in the input (#177)", () => {
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
    const table = Effect.runSync(
      pipe(
        scanCsv(csv, undefined, { treatFirstRowAsHeader: true }),
        Effect.ensuring(
          Effect.sync(() => {
            String.prototype.charCodeAt = charCodeAt;
          }),
        ),
      ),
    );
    expect(table.rows).toHaveLength(2001);
    // linear: a few reads per character (about two today); the quadratic row
    // lookup this guards against made about a thousand
    expect(reads).toBeLessThan(10 * csv.length);
  });
});

describe("CSV stream scanner", () => {
  const collect = (chunks: ReadonlyArray<string>, options?: Parameters<typeof scanCsvStream>[2]) =>
    Effect.runPromise(
      Effect.result(
        Stream.runCollect(
          scanCsvStream(Stream.fromIterable(chunks), undefined, {
            treatFirstRowAsHeader: false,
            ...options,
          }),
        ),
      ),
    );

  test("rows may be split across chunks anywhere", async () => {
    const r = await collect(['a,"b', '\n""c"', '""\r', "\nd,e"]);
    expect(Result.isSuccess(r) && [...r.success]).toEqual([
      ["a", 'b\n"c"'],
      ["d", "e"],
    ]);
  });

  test("emits rows before the stream ends", async () => {
    const first = await Effect.runPromise(
      pipe(
        Stream.concat(Stream.make("a,b\n"), Stream.never),
        (s) => scanCsvStream(s, undefined, { treatFirstRowAsHeader: false }),
        Stream.take(1),
        Stream.runCollect,
      ),
    );
    expect([...first]).toEqual([["a", "b"]]);
  });

  test("skips the header row and validates column counts", async () => {
    const ok = await collect(["h1,h2\n1,", "2\n"], { treatFirstRowAsHeader: true });
    expect(Result.isSuccess(ok) && [...ok.success]).toEqual([["1", "2"]]);
    const bad = await collect(["h1,h2\n1\n"], { treatFirstRowAsHeader: true });
    expect(Result.isFailure(bad) && bad.failure._tag).toBe("ParseError");
  });

  test("skipRows drops physical lines across chunk boundaries", async () => {
    const r = await collect(["junk", " line\nmore\na,b\n"], { skipRows: 2 });
    expect(Result.isSuccess(r) && [...r.success]).toEqual([["a", "b"]]);
  });

  test("skipRows counts bare CR and CRLF split across chunks", async () => {
    const r = await collect(["junk\r", "\nmore\r", "a,b\r", "\nc,d\n"], { skipRows: 2 });
    expect(Result.isSuccess(r) && [...r.success]).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
  });

  test("syntax errors carry their source position", async () => {
    const r = await collect(["x\n", "a,b\nc,", '"d\ne\n'], { skipRows: 1 });
    expect(Result.isFailure(r) && r.failure.reason).toBe(
      "Unclosed quoted field: expected a closing quote",
    );
    expect(Result.isFailure(r) && r.failure.position).toEqual({ row: 4, column: 0 });
  });

  test("column-count errors report the source row", async () => {
    const r = await collect(['a,"b\nc"\n\n', "d\n"]);
    expect(Result.isFailure(r) && r.failure.position).toEqual({ row: 3 });
  });

  test("providedHeaders replace the header row and set the width", async () => {
    const r = await collect(["h\n1,2\n"], {
      treatFirstRowAsHeader: true,
      providedHeaders: ["x", "y"],
    });
    expect(Result.isSuccess(r) && [...r.success]).toEqual([["1", "2"]]);
  });

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
    run(Effect.result(Effect.map(scanCsv(source, undefined, options), (t) => t.rows)));

  test("the compiled row grammar agrees with the whole-text scan at every chunk size", async () => {
    const source = ' a , "b ""q"" \r\nc" ,d\n# note\n\n e,"f",g \r1,"x\ny",3\n';
    const optionSets = [
      {},
      { trimWhitespace: true, lineCommentMarker: "#" },
      { filterEmpty: false, allowVariableColumns: true, quoteAnywhere: true },
    ];
    // sizes repeat: a later run reuses the memoized compiled parser
    const sizes = [1, 2, 3, 7, source.length, 1, source.length];
    const pairs = await Promise.all(
      optionSets.flatMap((options) =>
        sizes.map(async (size) => ({
          whole: outcome(await scanWhole(source, options)),
          streamed: outcome(await collect(chunksOf(source, size), options)),
        })),
      ),
    );
    expect(pairs.map((p) => p.streamed)).toEqual(pairs.map((p) => p.whole));
  });

  test("a syntax error matches the whole-text scan at every chunk size", async () => {
    const source = 'a,b\nc,"d\ne,f\n';
    const whole = outcome(await scanWhole(source, undefined));
    expect(whole).toHaveProperty("reason", "Unclosed quoted field: expected a closing quote");
    const streamed = await Promise.all(
      [1, 2, 5, 64].map(async (size) => outcome(await collect(chunksOf(source, size)))),
    );
    expect(streamed).toEqual([whole, whole, whole, whole]);
  });

  test("ignores a leading byte order mark", async () => {
    const r = await collect(["", "﻿a,b\n"]);
    expect(Result.isSuccess(r) && [...r.success]).toEqual([["a", "b"]]);
  });
});

describe("CSV writer", () => {
  test("round-trips through reader -> writer", async () => {
    const input = "product,price\nLaptop,999.99\nMouse,24.99\n";
    const doc = await run(makeCsvReader().read(text(input)));
    const out = await run(makeCsvWriter().write(doc));
    expect(out._tag).toBe("Text");
    assert(Predicate.isTagged(out, "Text"));
    expect(out.text).toBe(input);
  });

  test("round-trips fields containing quotes and line breaks", async () => {
    const doc = document([worksheet("Sheet1", [[cell.text('say "hi"\nthere'), cell.text("x")]])]);
    const out = await run(makeCsvWriter().write(doc as never));
    const back = await run(makeCsvReader().read(out));
    expect(firstWorksheet(back).rows[0]!.cells).toEqual([
      cell.text('say "hi"\nthere'),
      cell.text("x"),
    ]);
  });

  test("quotes fields containing the separator", async () => {
    const doc = await run(makeCsvReader().read(text('a,"b,c"\n')));
    const out = await run(makeCsvWriter().write(doc));
    assert(Predicate.isTagged(out, "Text"));
    expect(out.text).toBe('a,"b,c"\n');
  });

  const sheet = (rows: ReadonlyArray<ReadonlyArray<SheetCell>>) =>
    document([worksheet("Sheet1", rows)]) as never;
  const written = async (
    rows: ReadonlyArray<ReadonlyArray<SheetCell>>,
    options?: CsvWriterOptions,
  ) => {
    const out = await run(makeCsvWriter(options).write(sheet(rows)));
    return Predicate.isTagged(out, "Text") ? out.text : "";
  };

  test("keeps rows holding a single blank cell", async () => {
    const rows = ["a", "", "b", "", "c"].map((v) => [v === "" ? cell.blank() : cell.text(v)]);
    const out = await written(rows);
    expect(out).toBe('a\n""\nb\n""\nc\n');
    expect(firstWorksheet(await run(makeCsvReader().read(text(out)))).rows).toHaveLength(5);
    expect(renderTable([["a"], [""]])).toBe('a\n""\n');
  });

  test("writes NaN and the infinities as text, as pandas does (#89)", async () => {
    expect([Number.NaN, Infinity, -Infinity].map(formatCsvNumber)).toEqual([
      "NaN",
      "Infinity",
      "-Infinity",
    ]);
    const out = await written([
      [cell.number(Number.NaN), cell.number(Infinity), cell.number(-Infinity)],
    ]);
    expect(out).toBe("NaN,Infinity,-Infinity\n");
    // they read back as text: the strict number grammar never accepts them
    expect(firstWorksheet(await run(makeCsvReader().read(text(out)))).rows[0]?.cells).toEqual([
      cell.text("NaN"),
      cell.text("Infinity"),
      cell.text("-Infinity"),
    ]);
  });

  test("writes numbers as shortest round-trip decimals", async () => {
    expect([1e21, -1.5e-7, 0.1, 123.456, -0, 2 ** 70].map(formatCsvNumber)).toEqual([
      "1000000000000000000000",
      "-0.00000015",
      "0.1",
      "123.456",
      "0",
      "1180591620717411300000",
    ]);
    expect(await written([[cell.number(1e21)]])).toBe("1000000000000000000000\n");
    expect(await written([[cell.number(1.5)]], { formatNumber: (n) => n.toFixed(2) })).toBe(
      "1.50\n",
    );
  });

  test("quotes fields with edge whitespace or a leading comment marker", async () => {
    const row = [cell.text(" a"), cell.text("b "), cell.text("#c"), cell.text("d#")];
    expect(await written([row])).toBe('" a","b ",#c,d#\n');
    expect(await written([row], { lineCommentMarker: "#" })).toBe('" a","b ","#c",d#\n');
  });

  test("escapeFormulae prefixes and quotes formula-like text", async () => {
    const row = [
      cell.text('=HYPERLINK("x")'),
      cell.text("+1"),
      cell.text("-a"),
      cell.text("@b"),
      cell.text("\tc"),
      cell.number(-1),
      cell.text("ok"),
    ];
    expect(await written([row])).toBe('"=HYPERLINK(""x"")",+1,-a,@b,"\tc",-1,ok\n');
    expect(await written([row], { escapeFormulae: true })).toBe(
      `"'=HYPERLINK(""x"")","'+1","'-a","'@b","'\tc",-1,ok\n`,
    );
  });

  test("quoting modes", async () => {
    const row = [cell.text("a"), cell.number(1), cell.boolean(true), cell.blank()];
    expect(await written([row], { quoting: "all" })).toBe('"a","1","true",""\n');
    expect(await written([row], { quoting: "nonNumeric" })).toBe('"a",1,"true",""\n');
    expect(await written([row], { quoting: "none" })).toBe("a,1,true,\n");
    const r = await Effect.runPromise(
      Effect.result(makeCsvWriter({ quoting: "none" }).write(sheet([[cell.text("a,b")]]))),
    );
    expect(Result.isFailure(r) && r.failure.reason).toBe(
      "Row 0 has a field that needs quotes and cannot be written without quoting",
    );
  });

  test("escapeChar escapes the wrapper instead of doubling it (#89)", async () => {
    const row = [cell.text('say "hi"'), cell.text("C:\\tmp"), cell.text("plain"), cell.number(1)];
    expect(await written([row], { escapeChar: "\\" })).toBe('"say \\"hi\\"","C:\\\\tmp",plain,1\n');
    expect(await written([row], { escapeChar: "\\", quoting: "all" })).toBe(
      '"say \\"hi\\"","C:\\\\tmp","plain","1"\n',
    );
    // a reader whose quote escape is `\"` reads the wrapper back
    const out = await written([[cell.text('say "hi"'), cell.text("x")]], { escapeChar: "\\" });
    const back = await run(
      makeCsvReader({ dialect: { ...StandardDialect, doubleWrapper: '\\"' } }).read(text(out)),
    );
    expect(firstWorksheet(back).rows[0]?.cells).toEqual([cell.text('say "hi"'), cell.text("x")]);
  });

  test("escapeChar lets quoting none escape what would need quotes (#89)", async () => {
    const row = [cell.text("a,b"), cell.text('c"d'), cell.text("e\nf"), cell.text("g\\h")];
    expect(await written([row], { escapeChar: "\\", quoting: "none" })).toBe(
      'a\\,b,c\\"d,e\\\nf,g\\\\h\n',
    );
    const r = await Effect.runPromise(
      Effect.result(
        makeCsvWriter({ escapeChar: "\\", quoting: "none" }).write(sheet([[cell.blank()]])),
      ),
    );
    expect(Result.isFailure(r) && r.failure.reason).toBe(
      "Row 0 is a single empty field and cannot be written without quoting",
    );
  });

  test("escapeChar must be one character other than the separator or wrapper (#89)", async () => {
    const results = await Effect.runPromise(
      Effect.forEach(
        ["", "\\\\", ",", '"', "\n"],
        (escapeChar) =>
          Effect.result(makeCsvWriter({ escapeChar }).write(sheet([[cell.text("a")]]))),
        { concurrency: 1 },
      ),
    );
    expect(results.map(Result.isFailure)).toEqual([true, true, true, true, true]);
    const streamed = await Effect.runPromise(
      Effect.result(
        Stream.runCollect(
          renderCsvStream(Stream.make(new SheetRow({ cells: [cell.text("a")] })), {
            escapeChar: ",",
          }),
        ),
      ),
    );
    expect(Result.isFailure(streamed) && streamed.failure.reason).toBe(
      "escapeChar must differ from the separator, the wrapper and line breaks",
    );
  });

  test("line breaks come from the dialect", async () => {
    expect(await written([[cell.text("a")], [cell.text("b")]], { dialect: Rfc4180Dialect })).toBe(
      "a\r\nb\r\n",
    );
  });

  test("bom, headers and padRows", async () => {
    const rows = [[cell.text("a")], [cell.text("b"), cell.text("c"), cell.text("d")]];
    expect(await written(rows, { bom: true, headers: ["x", "y"], padRows: true })).toBe(
      "﻿x,y,\na,,\nb,c,d\n",
    );
    expect(await written([], { headers: ["x"] })).toBe("x\n");
  });

  test("renderCsvStream emits a chunk per row", async () => {
    const rows = [[cell.text("a"), cell.number(1e21)], [cell.blank()], [cell.text("b,c")]];
    const options: CsvWriterOptions = { headers: ["x", "y"], padRows: true, bom: true };
    const chunks = await run(
      Stream.runCollect(
        renderCsvStream(Stream.fromIterable(rows.map((cells) => new SheetRow({ cells }))), options),
      ),
    );
    expect([...chunks]).toEqual(["﻿", "x,y\n", "a,1000000000000000000000\n", ",\n", '"b,c",\n']);
    expect([...chunks].join("")).toBe(await written(rows, options));
  });
});

describe("synthesizeDocument", () => {
  test("is reproducible with a seed and conforms to CSV", async () => {
    const a = await run(synthesizeDocument({ columns: ["x", "y"], quantity: 5, seed: 42 }));
    const b = await run(synthesizeDocument({ columns: ["x", "y"], quantity: 5, seed: 42 }));
    expect(a).toEqual(b);
    const ws = firstWorksheet(a);
    expect(ws.rows).toHaveLength(6); // header + 5
  });
});

describe("validateHeaders (#87)", () => {
  const scan = (text: string, options: Parameters<typeof scanCsv>[2]) =>
    Effect.runSync(Effect.result(scanCsv(text, undefined, options)));
  const stream = (text: string, options: Parameters<typeof scanCsvStream>[2]) =>
    Effect.runPromise(
      Effect.result(Stream.runCollect(scanCsvStream(Stream.make(text), undefined, options))),
    );

  test("is off by default: duplicate and empty names are kept", () => {
    const r = scan(",a,a\n1,2,3\n", { treatFirstRowAsHeader: true });
    expect(Result.isSuccess(r) && r.success.headers).toEqual(["", "a", "a"]);
  });

  test("rejects an empty or whitespace-only name with its column", () => {
    const first = scan(",a,b\n1,2,3\n", { treatFirstRowAsHeader: true, validateHeaders: true });
    assert(Result.isFailure(first));
    expect(first.failure.reason).toBe("Header 1 is empty");
    expect(first.failure.position).toEqual({ row: 0, column: 0 });
    const blank = scan("a, ,b\n1,2,3\n", { treatFirstRowAsHeader: true, validateHeaders: true });
    assert(Result.isFailure(blank));
    expect(blank.failure.reason).toBe("Header 2 is empty");
  });

  test("rejects a repeated name, naming both columns", () => {
    const r = scan("a,b,a\n1,2,3\n", { treatFirstRowAsHeader: true, validateHeaders: true });
    assert(Result.isFailure(r));
    expect(r.failure.reason).toBe('Header "a" appears in columns 1 and 3');
    expect(r.failure.position).toEqual({ row: 0, column: 2 });
  });

  test("checks providedHeaders too, and passes valid headers through", () => {
    const bad = scan("1,2\n", { providedHeaders: ["x", "x"], validateHeaders: true });
    assert(Result.isFailure(bad));
    expect(bad.failure.position?.row).toBeUndefined();
    const good = scan("a,b\n1,2\n", { treatFirstRowAsHeader: true, validateHeaders: true });
    expect(Result.isSuccess(good) && good.success.headers).toEqual(["a", "b"]);
  });

  test("the stream scanner applies the same check", async () => {
    const fromRow = await stream("a,a\n1,2\n", {
      treatFirstRowAsHeader: true,
      validateHeaders: true,
    });
    assert(Result.isFailure(fromRow));
    expect(fromRow.failure.reason).toBe('Header "a" appears in columns 1 and 2');
    const provided = await stream("1,2\n", { providedHeaders: ["", "y"], validateHeaders: true });
    assert(Result.isFailure(provided));
    expect(provided.failure.reason).toBe("Header 1 is empty");
    const ok = await stream("a,b\n1,2\n", { treatFirstRowAsHeader: true, validateHeaders: true });
    expect(Result.isSuccess(ok) && [...ok.success]).toEqual([["1", "2"]]);
  });
});
