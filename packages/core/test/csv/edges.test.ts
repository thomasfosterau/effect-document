/**
 * CSV edge cases from #92's list: empty input, a lone empty field, a BOM in
 * text input, CR-only line breaks with skipped rows, TSV round trips, and
 * synthesis seeds outside the generator's range.
 */

import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import { assert, describe, expect, test } from "vite-plus/test";
import { rowCellsOf, text } from "../../src/index.ts";
import {
  type CsvDialect,
  makeCsvReader,
  readCsvRows,
  scanCsv,
  synthesizeTable,
  tsvFormat,
} from "../../src/csv/index.ts";

const CR: CsvDialect = { separator: ",", linebreak: "\r", wrapper: '"', doubleWrapper: '""' };

/** The rows of a synthesized table. */
const synthesized = (seed: number) =>
  Effect.runSync(synthesizeTable({ columns: 2, quantity: 3, seed })).rows;

describe("CSV edge cases (#92)", () => {
  test("empty input reads as one empty worksheet, and as no rows", () => {
    const doc = Effect.runSync(makeCsvReader().read(text("")));
    const [ws] = doc.blocks;
    assert(ws !== undefined && Predicate.isTagged(ws, "Worksheet"));
    expect(ws.rows).toEqual([]);
    expect(Effect.runSync(readCsvRows("", { treatFirstRowAsHeader: true }))).toEqual({
      headers: null,
      rows: [],
    });
  });

  test("a lone quoted empty field is one row of one empty field; a bare line break is none", () => {
    expect(Effect.runSync(scanCsv('""')).rows).toEqual([[""]]);
    expect(Effect.runSync(scanCsv("\n")).rows).toEqual([]);
  });

  test("a UTF-8 BOM at the start of text input is not part of the first header", () => {
    const read = Effect.runSync(readCsvRows("﻿a,b\n1,2\n", { treatFirstRowAsHeader: true }));
    expect(read.headers).toEqual(["a", "b"]);
    const doc = Effect.runSync(
      makeCsvReader({ treatFirstRowAsHeader: true }).read(text("﻿a,b\n1,2\n")),
    );
    const [ws] = doc.blocks;
    assert(ws !== undefined && Predicate.isTagged(ws, "Worksheet"));
    const [header] = ws.rows;
    assert(header !== undefined);
    expect(rowCellsOf(header)).toEqual(["a", "b"]);
  });

  test("CR-only line breaks with skipped preamble rows", () => {
    expect(
      Effect.runSync(
        readCsvRows("preamble\rname,qty\r1,2\r", {
          dialect: CR,
          skipRows: 1,
          treatFirstRowAsHeader: true,
        }),
      ),
    ).toEqual({ headers: ["name", "qty"], rows: [[1, 2]] });
  });

  test("TSV round-trips a field holding a tab, quoted", () => {
    const tsv = 'a\tb\nx y\t"q\tz"\n';
    const reader = tsvFormat.reader;
    const writer = tsvFormat.writer;
    assert(reader !== undefined && writer !== undefined);
    const doc = Effect.runSync(reader.read(text(tsv)));
    expect(Effect.runSync(writer.write(doc))).toEqual(text(tsv));
  });
});

describe("synthesis seeds (#92)", () => {
  test("a seed in the generator's range keeps its table", () => {
    // recorded before seeds were normalised: valid seeds must not change
    expect(Effect.runSync(synthesizeTable({ columns: 2, quantity: 2, seed: 42 })).rows).toEqual([
      ["JpBO7", "ScoVHCa1EYXFLD3"],
      ["A1x4cfvtz7MLk6125", "jlEQCadyWGM3ud"],
    ]);
  });

  test("seed 0 is random-looking, not a run of a's, and reproducible", () => {
    const rows = synthesized(0);
    expect(rows.flat().some((field) => /[^a]/.test(field))).toBe(true);
    expect(synthesized(0)).toEqual(rows);
  });

  test.each([-5, 3.7, 2 ** 40, Number.NaN])(
    "seed %d gives fields of the requested lengths, reproducibly",
    (seed) => {
      const rows = synthesized(seed);
      expect(rows.flat().every((field) => field.length >= 5 && field.length <= 20)).toBe(true);
      expect(synthesized(seed)).toEqual(rows);
    },
  );
});
