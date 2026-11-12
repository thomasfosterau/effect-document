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
  rowCellsOf,
  space,
  str,
  strong,
  trustAs,
  type Worksheet,
  worksheet,
} from "@thomasfosterau/effect-document";
import { makeXlsxReader, makeXlsxWriter, type XlsxFeature } from "../../../src/ooxml/xlsx/index.ts";

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

  test("a link over part of a cell is written over the whole cell, and reported", () => {
    const partial = new CellRichText({
      runs: [str("see"), space(), strong([link([str("here")], "https://example.com")])],
    });
    const [content, notes] = write([worksheet("S", [[partial]])]);
    expect(notes.map((n) => [n.code, n.severity, n.path])).toEqual([
      ["xlsx.hyperlinkWidened", "converted", ["S", "A1"]],
    ]);
    const [back] = read(bytesOf(content));
    const [cell] = rowCellsOf(back.rows[0] ?? []);
    assert(Predicate.isTagged(cell, "CellRichText"));
    // the cell's text and bold come back, linked as a whole
    expect(cell.runs).toEqual([
      link(
        [str("see"), expect.objectContaining({ _tag: "Space" }), strong([str("here")])],
        "https://example.com",
      ),
    ]);
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
