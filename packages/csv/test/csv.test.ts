import { describe, expect, test } from "bun:test";
import { Effect, Result, Stream, pipe } from "effect";
import { cell, document, text, Worksheet, worksheet } from "@thomasfosterau/effect-document";
import {
  type CsvReaderOptions, StandardDialect, TsvDialect, inferCell, makeCsvReader, makeCsvWriter, scanCsv,
  scanCsvStream, synthesizeDocument,
} from "../src/index.js";

const run = <A, E>(e: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(e);

const firstWorksheet = (doc: { blocks: ReadonlyArray<{ _tag: string }> }): Worksheet =>
  doc.blocks.find((b) => b._tag === "Worksheet") as Worksheet;

describe("CSV reader", () => {
  test("infers number/boolean/blank cells", async () => {
    const doc = await run(makeCsvReader().read(text("alice,30,true\nbob,,false\n")));
    const ws = firstWorksheet(doc);
    expect(ws.rows[0]!.cells.map((c) => c._tag)).toEqual(["CellText", "CellNumber", "CellBoolean"]);
    expect(ws.rows[1]!.cells[1]!._tag).toBe("CellBlank");
  });

  test("inferTypes: false keeps every value as text", async () => {
    const doc = await run(makeCsvReader({ inferTypes: false }).read(text("1,true\n")));
    const ws = firstWorksheet(doc);
    expect(ws.rows[0]!.cells.every((c) => c._tag === "CellText")).toBe(true);
  });

  test("header row is read as text cells", async () => {
    const doc = await run(
      makeCsvReader({ treatFirstRowAsHeader: true }).read(text("name,age\nalice,30\n"))
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

  const cells = async (input: string, options?: CsvReaderOptions) =>
    firstWorksheet(await run(makeCsvReader(options).read(text(input)))).rows.map((r) =>
      r.cells.map((c) => ("value" in c ? c.value : null))
    );

  test("reads only plain decimals as numbers", async () => {
    expect(inferCell("007")).toEqual(cell.text("007"));
    const values = ["007", "02134", "0x1F", "0b11", "+1", " 12 ", "1.", ".5", "Infinity", "12345678901234567890",
      "1234567890.12345", "0", "-12.5", "1e3", "1000000000000000000000", "0.000123"];
    expect((await cells(values.join(",")))[0]).toEqual([
      "007", "02134", "0x1F", "0b11", "+1", " 12 ", "1.", ".5", "Infinity", "12345678901234567890",
      1234567890.12345, 0, -12.5, 1000, 1e21, 0.000123,
    ]);
  });

  test("booleans are case-insensitive and configurable", async () => {
    expect(await cells("TRUE,False,yes\n")).toEqual([[true, false, "yes"]]);
    expect(await cells("TRUE,true\n", { booleansCaseSensitive: true })).toEqual([["TRUE", true]]);
    expect(await cells("yes,NO,true\n", { booleans: ["yes", "no"] })).toEqual([[true, false, "true"]]);
    expect(await cells("true\n", { booleans: false })).toEqual([["true"]]);
  });

  test("decimalChar, groupChar and percent", async () => {
    const options: CsvReaderOptions = { dialect: { ...TsvDialect }, decimalChar: ",", groupChar: ".", percent: true };
    expect(await cells("1.234,56\t1234,5\t12%\t7%\t1.23,4\t12,34.5\n", options)).toEqual([
      [1234.56, 1234.5, 0.12, 0.07, "1.23,4", "12,34.5"],
    ]);
    expect(await cells('"1,234.56",12%\n', { groupChar: "," })).toEqual([[1234.56, "12%"]]);
  });

  test("nullValues become blank cells", async () => {
    const doc = await run(makeCsvReader({ nullValues: ["", "NA", "NULL"] }).read(text("NA,NULL,,na\n")));
    expect(firstWorksheet(doc).rows[0]!.cells.map((c) => c._tag)).toEqual(["CellBlank", "CellBlank", "CellBlank", "CellText"]);
  });

  test("column inference types a column by all its values", async () => {
    const input = "1,true,a,1\n2,false,,x\n,TRUE,b,3\n";
    expect(await cells(input, { inference: "column" })).toEqual([
      [1, true, "a", "1"], [2, false, null, "x"], [null, true, "b", "3"],
    ]);
    expect(await cells(input)).toEqual([[1, true, "a", 1], [2, false, null, "x"], [null, true, "b", 3]]);
    // the header row is excluded from inference
    expect(await cells("id,ok\n1,true\n", { inference: "column", treatFirstRowAsHeader: true })).toEqual([
      ["id", "ok"], [1, true],
    ]);
  });

  test("readStream yields rows", async () => {
    const rows = await run(
      pipe(makeCsvReader().readStream!(text("a,b\nc,d\n")), Stream.runCollect)
    );
    expect([...rows]).toEqual([["a", "b"], ["c", "d"]]);
  });
});

describe("CSV scanner", () => {
  const rows = (input: string, options?: Parameters<typeof scanCsv>[2]) =>
    Effect.runSync(scanCsv(input, undefined, options)).rows;

  test("quoted fields may contain separators, doubled quotes and line breaks", () => {
    expect(rows('a,"b,""c""\nd"\ne,f')).toEqual([["a", 'b,"c"\nd'], ["e", "f"]]);
  });

  test("a wrapper inside an unquoted field is literal", () => {
    expect(rows('12" pizza,3\n6" sub,2\n')).toEqual([['12" pizza', "3"], ['6" sub', "2"]]);
    expect(rows('"a"b,c')).toEqual([["ab", "c"]]);
  });

  test("quoteAnywhere: quoted and unquoted segments mix within a field", () => {
    expect(rows('x"y,z"w,""', { quoteAnywhere: true })).toEqual([["xy,zw", ""]]);
  });

  test("an empty wrapper turns quoting off", () => {
    const dialect = { ...StandardDialect, wrapper: "", doubleWrapper: "" };
    expect(Effect.runSync(scanCsv('"a,b"\n', dialect)).rows).toEqual([['"a', 'b"']]);
  });

  test("multi-character separators are matched whole", () => {
    const dialect = { ...StandardDialect, separator: "||" };
    expect(Effect.runSync(scanCsv("a|b||c\n|||\n", dialect)).rows).toEqual([["a|b", "c"], ["", "|"]]);
  });

  test("skipRows counts CRLF, LF and bare CR line endings", () => {
    expect(rows("junk\rmore\r\na,b\rc,d\r", { skipRows: 2 })).toEqual([["a", "b"], ["c", "d"]]);
  });

  test("trimWhitespace keeps whitespace inside quotes", () => {
    expect(rows(' " a " , b \n', { trimWhitespace: true })).toEqual([[" a ", "b"]]);
    expect(Effect.runSync(scanCsv('\t" a "\t\n', TsvDialect, { trimWhitespace: true })).rows).toEqual([["", " a ", ""]]);
  });

  test("providedHeaders replace the header row", () => {
    const table = Effect.runSync(
      scanCsv("h1,h2\n1,2\n", undefined, { treatFirstRowAsHeader: true, providedHeaders: ["x", "y"] })
    );
    expect(table).toEqual({ headers: ["x", "y"], rows: [["1", "2"]] });
  });

  test("ignores a leading byte order mark", () => {
    expect(rows("﻿a,b\n")).toEqual([["a", "b"]]);
  });

  test("accepts LF, CRLF and bare CR line endings", () => {
    expect(rows("a,b\r\nc,d\re,f\n")).toEqual([["a", "b"], ["c", "d"], ["e", "f"]]);
  });

  test("skips blank and comment lines, trims, and skips leading rows", () => {
    const input = "title line\n# a comment\n  \n a , b \n";
    expect(rows(input, { skipRows: 1, lineCommentMarker: "#", trimWhitespace: true })).toEqual([["a", "b"]]);
    expect(rows("a\n\nb\n", { filterEmpty: false })).toEqual([["a"], [""], ["b"]]);
  });

  test("uses the dialect separator", () => {
    expect(Effect.runSync(scanCsv("a\tb,c\n", TsvDialect)).rows).toEqual([["a", "b,c"]]);
  });

  test("an unclosed quote fails with its line and column", () => {
    const r = Effect.runSync(Effect.result(scanCsv('a,b\nc,"d\ne\n')));
    expect(Result.isFailure(r)).toBe(true);
    if (Result.isFailure(r)) {
      expect(r.failure.reason).toContain("closing quote");
      expect(r.failure.position).toEqual({ row: 3, column: 0 });
    }
  });

  test("rejects rows with the wrong column count", () => {
    const r = Effect.runSync(Effect.result(scanCsv("a,b\n1\n", undefined, { treatFirstRowAsHeader: true })));
    expect(Result.isFailure(r) && r.failure.position).toEqual({ row: 1 });
  });

  test("without headers, rows must match the first row's width", () => {
    const r = Effect.runSync(Effect.result(scanCsv("a,b\nc\n")));
    expect(Result.isFailure(r) && r.failure.reason).toBe("Row 1 has 1 columns, expected 2");
    expect(rows("a,b\nc\n", { allowVariableColumns: true })).toEqual([["a", "b"], ["c"]]);
  });

  test("column-count errors report the source row", () => {
    const r = Effect.runSync(Effect.result(scanCsv('# note\n\na,"b\nc"\r\nd\n', undefined, { lineCommentMarker: "#" })));
    expect(Result.isFailure(r) && r.failure.position).toEqual({ row: 4 });
  });
});

describe("CSV stream scanner", () => {
  const collect = (chunks: ReadonlyArray<string>, options?: Parameters<typeof scanCsvStream>[2]) =>
    Effect.runPromise(Effect.result(Stream.runCollect(scanCsvStream(Stream.fromIterable(chunks), undefined, options))));

  test("rows may be split across chunks anywhere", async () => {
    const r = await collect(['a,"b', '\n""c"', '""\r', "\nd,e"]);
    expect(Result.isSuccess(r) && [...r.success]).toEqual([["a", 'b\n"c"'], ["d", "e"]]);
  });

  test("emits rows before the stream ends", async () => {
    const first = await Effect.runPromise(
      pipe(
        Stream.concat(Stream.make("a,b\n"), Stream.never),
        (s) => scanCsvStream(s),
        Stream.take(1),
        Stream.runCollect
      )
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
    expect(Result.isSuccess(r) && [...r.success]).toEqual([["a", "b"], ["c", "d"]]);
  });

  test("syntax errors carry their source position", async () => {
    const r = await collect(["x\n", "a,b\nc,", '"d\ne\n'], { skipRows: 1 });
    expect(Result.isFailure(r) && r.failure.reason).toBe("Unclosed quoted field: expected a closing quote");
    expect(Result.isFailure(r) && r.failure.position).toEqual({ row: 4, column: 0 });
  });

  test("column-count errors report the source row", async () => {
    const r = await collect(['a,"b\nc"\n\n', "d\n"]);
    expect(Result.isFailure(r) && r.failure.position).toEqual({ row: 3 });
  });

  test("providedHeaders replace the header row and set the width", async () => {
    const r = await collect(["h\n1,2\n"], { treatFirstRowAsHeader: true, providedHeaders: ["x", "y"] });
    expect(Result.isSuccess(r) && [...r.success]).toEqual([["1", "2"]]);
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
    if (out._tag === "Text") expect(out.text).toBe(input);
  });

  test("round-trips fields containing quotes and line breaks", async () => {
    const doc = document([worksheet("Sheet1", [[cell.text('say "hi"\nthere'), cell.text("x")]])]);
    const out = await run(makeCsvWriter().write(doc as never));
    const back = await run(makeCsvReader().read(out));
    expect(firstWorksheet(back).rows[0]!.cells).toEqual([cell.text('say "hi"\nthere'), cell.text("x")]);
  });

  test("quotes fields containing the separator", async () => {
    const doc = await run(makeCsvReader().read(text('a,"b,c"\n')));
    const out = await run(makeCsvWriter().write(doc));
    if (out._tag === "Text") expect(out.text).toBe('a,"b,c"\n');
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
