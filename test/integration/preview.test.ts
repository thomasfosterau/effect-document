/**
 * Preview reads (#188): `maxRows` bounds what a reader returns, and a
 * truncated document always says so, so a preview never passes for the
 * whole file.
 */

import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import { assert, describe, expect, test } from "vite-plus/test";
import {
  cell,
  type Content,
  document,
  isTruncated,
  rowCellsOf,
  text,
  trustAs,
  truncationOf,
  worksheet,
  type Document,
} from "@thomasfosterau/effect-document";
import * as Csv from "@thomasfosterau/effect-document/csv";
import { makeXlsxReader, makeXlsxWriter } from "@thomasfosterau/effect-document/ooxml/xlsx";

const run = <A, E>(e: Effect.Effect<A, E>): A => Effect.runSync(e);

/** The worksheets of a document. */
const sheets = (doc: Document) => doc.blocks.filter((b) => Predicate.isTagged(b, "Worksheet"));

// a quoted field spans a line break: records, not lines, are counted
const CSV = 'name,qty\n"multi\nline",1\nb,2\nc,3\nd,4\n';

describe("CSV preview reads (#188)", () => {
  test("reads the first maxRows records, a header counting as one, and says it was cut", () => {
    const doc = run(Csv.makeCsvReader({ maxRows: 3 }).read(text(CSV)));
    const [ws] = sheets(doc);
    assert(ws !== undefined && Predicate.isTagged(ws, "Worksheet"));
    expect(ws.rows.map((r) => rowCellsOf(r).length)).toEqual([2, 2, 2]);
    expect(isTruncated(doc)).toBe(true);
    expect(truncationOf(doc)).toEqual({ maxRows: 3, sheets: ["Sheet1"] });
  });

  test("a limit the file fits in reads it whole, unmarked", () => {
    const whole = run(Csv.makeCsvReader().read(text(CSV)));
    const preview = run(Csv.makeCsvReader({ maxRows: 100 }).read(text(CSV)));
    expect(isTruncated(preview)).toBe(false);
    expect(preview).toEqual(whole);
  });

  test("skipRows lines come before the limit", () => {
    const doc = run(Csv.makeCsvReader({ skipRows: 1, maxRows: 2 }).read(text(`preamble\n${CSV}`)));
    const [ws] = sheets(doc);
    assert(ws !== undefined && Predicate.isTagged(ws, "Worksheet"));
    expect(ws.rows).toHaveLength(2);
    expect(isTruncated(doc)).toBe(true);
  });
});

/** A workbook of a four-row sheet and a one-row sheet. */
const workbook = (): Content =>
  run(
    makeXlsxWriter().write(
      trustAs<never>(
        document([
          worksheet("Long", [
            [cell.text("h")],
            [cell.number(1)],
            [cell.number(2)],
            [cell.number(3)],
          ]),
          worksheet("Short", [[cell.text("h")]]),
        ]),
      ),
    ),
  );

describe("XLSX preview reads (#188)", () => {
  test("keeps maxRows rows of each sheet and names the sheets it cut", () => {
    const doc = run(makeXlsxReader({ maxRows: 2 }).read(workbook()));
    expect(
      sheets(doc).map((ws) => (Predicate.isTagged(ws, "Worksheet") ? ws.rows.length : -1)),
    ).toEqual([2, 1]);
    expect(truncationOf(doc)).toEqual({ maxRows: 2, sheets: ["Long"] });
  });

  test("without a sheet over the limit, the document is unmarked", () => {
    expect(isTruncated(run(makeXlsxReader({ maxRows: 10 }).read(workbook())))).toBe(false);
  });
});
