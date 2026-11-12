import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { assert, describe, expect, test } from "vite-plus/test";
import {
  bytes,
  CellRichText,
  collectDiagnostics,
  type Content,
  type Diagnostic,
  document,
  link,
  narrow,
  rowCellsOf,
  space,
  str,
  strong,
  trustAs,
  type Worksheet,
  worksheet,
} from "@thomasfosterau/effect-document";
import {
  makeXlsxReader,
  makeXlsxWriter,
  Xlsx,
  type XlsxFeature,
} from "../../../src/ooxml/xlsx/index.ts";

const SHEET = "xl/worksheets/sheet1.xml";
const RELS = "xl/worksheets/_rels/sheet1.xml.rels";

/** The bytes of written content. */
const bytesOf = (c: Content): Uint8Array => {
  assert(Predicate.isTagged(c, "Bytes"), "the XLSX writer writes bytes");
  return c.bytes;
};

/** A part of a workbook, as text ("" when absent). */
const partOf = (data: Uint8Array, path: string): string =>
  strFromU8(unzipSync(data)[path] ?? new Uint8Array());

/** `sheets` written, with the diagnostics the write reported. */
const write = (sheets: ReadonlyArray<Worksheet>) =>
  Effect.runSync(
    collectDiagnostics(makeXlsxWriter().write(trustAs<XlsxFeature>(document(sheets)))),
  );

/** The first sheet `data` reads as, with the diagnostics the read reported. */
const read = (data: Uint8Array): readonly [Worksheet, ReadonlyArray<Diagnostic>] => {
  const [doc, found] = Effect.runSync(collectDiagnostics(makeXlsxReader().read(bytes(data))));
  const ws = doc.blocks[0];
  assert(ws !== undefined && Predicate.isTagged(ws, "Worksheet"), "a worksheet");
  return [ws, found];
};

/** A linked cell: its text, linked to `url`. */
const linked = (text: string, url: string, title?: string) =>
  new CellRichText({ runs: [link([str(text)], url, title)] });

describe("XLSX hyperlinks (#67)", () => {
  test("round-trip an external link (with its tooltip) and one inside the workbook", () => {
    const sheet = worksheet("S", [
      [linked("site", "https://example.com/a?b=1&c", "Go there"), linked("cell", "#Other!B2")],
    ]);
    const [content, notes] = write([sheet]);
    const data = bytesOf(content);
    expect(notes).toEqual([]);
    const xml = partOf(data, SHEET);
    expect(xml).toContain(
      'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"',
    );
    expect(xml).toContain(
      '<hyperlinks><hyperlink ref="A1" r:id="rId1" tooltip="Go there"/><hyperlink ref="B1" location="Other!B2"/></hyperlinks>',
    );
    expect(partOf(data, RELS)).toContain(
      'Target="https://example.com/a?b=1&amp;c" TargetMode="External"',
    );
    const [back, found] = read(data);
    expect(found).toEqual([]);
    expect(rowCellsOf(back.rows[0] ?? [])).toEqual(rowCellsOf(sheet.rows[0] ?? []));
  });

  test("a sheet without links writes no <hyperlinks>, no xmlns:r and no _rels part", () => {
    const [content] = write([worksheet("S", [["plain"]])]);
    const data = bytesOf(content);
    expect(partOf(data, SHEET)).not.toContain("hyperlink");
    expect(partOf(data, SHEET)).not.toContain("xmlns:r");
    expect(partOf(data, RELS)).toBe("");
  });

  test("narrow widens a link over part of a cell over the whole of it; the writer refuses one unwidened", () => {
    const partial = new CellRichText({
      runs: [str("see"), space(), strong([link([str("here")], "https://example.com")])],
    });
    const doc = document([worksheet("S", [[partial]])]);
    // the Xlsx profile's `whole` rule keeps a link to a cell's only run
    expect(Xlsx.is(doc)).toBe(false);
    const { document: narrowed, loss } = narrow(doc, Xlsx);
    expect(Xlsx.is(narrowed)).toBe(true);
    expect(loss.entries.map((e) => [e.feature, e.action])).toEqual([["inline.link", "converted"]]);
    expect(loss.entries[0]?.detail).toContain("SpreadsheetML links a whole cell");
    const ws = narrowed.blocks[0];
    assert(ws !== undefined && Predicate.isTagged(ws, "Worksheet"));
    const [cell] = rowCellsOf(ws.rows[0] ?? []);
    assert(Predicate.isTagged(cell, "CellRichText"));
    expect(cell.runs).toEqual([
      link(
        [str("see"), expect.objectContaining({ _tag: "Space" }), strong([str("here")])],
        "https://example.com",
      ),
    ]);
    // the widened cell round-trips
    const [content] = write([ws]);
    expect(rowCellsOf(read(bytesOf(content))[0].rows[0] ?? [])).toEqual([cell]);
    // built past the profile with trustAs, the writer refuses it rather than widen it silently
    const error = Effect.runSync(Effect.flip(makeXlsxWriter().write(trustAs<XlsxFeature>(doc))));
    expect(error.reason).toContain("S!A1 link only part of their text");
  });

  test("a range link covers each text cell in it; a cell that holds no text keeps its value and is reported", () => {
    const [content] = write([worksheet("S", [["a", "b", 3]])]);
    const files = unzipSync(bytesOf(content));
    const xml = partOf(bytesOf(content), SHEET)
      .replace(
        '<worksheet xmlns="',
        '<worksheet xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns="',
      )
      .replace(
        "</sheetData>",
        '</sheetData><hyperlinks><hyperlink ref="A1:C1" location="S!A1"/></hyperlinks>',
      );
    const edited = zipSync({ ...files, [SHEET]: strToU8(xml) });
    const [back, found] = read(edited);
    expect(rowCellsOf(back.rows[0] ?? [])).toEqual([linked("a", "#S!A1"), linked("b", "#S!A1"), 3]);
    expect(found.map((d) => [d.code, d.severity, d.path])).toEqual([
      ["xlsx.hyperlinkDropped", "dropped-content", ["S"]],
    ]);
    expect(found[0]?.detail).toContain("C1");
  });
});
