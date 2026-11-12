import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { assert, describe, expect } from "vite-plus/test";
import {
  bytes,
  CellRichText,
  type Content,
  document,
  emph,
  rowCellsOf,
  str,
  strong,
  subscript,
  trustAs,
  underline,
  worksheet,
} from "@thomasfosterau/effect-document";
import { makeXlsxReader, makeXlsxWriter, type XlsxFeature } from "../../../src/ooxml/xlsx/index.ts";

/** The bytes of written content. */
const bytesOf = (c: Content): Uint8Array => {
  assert(Predicate.isTagged(c, "Bytes"), "the XLSX writer writes bytes");
  return c.bytes;
};

/** A workbook's shared-string part, as text. */
const sstOf = (data: Uint8Array): string =>
  strFromU8(unzipSync(data)["xl/sharedStrings.xml"] ?? new Uint8Array());

/** `data` with its shared-string part replaced by `sst`. */
const withSst = (data: Uint8Array, sst: string): Uint8Array =>
  zipSync({ ...unzipSync(data), "xl/sharedStrings.xml": strToU8(sst) });

/** The first worksheet a read gives. */
const firstSheet = (data: Uint8Array) =>
  Effect.gen(function* () {
    const doc = yield* makeXlsxReader().read(bytes(data));
    const ws = doc.blocks[0];
    assert(ws !== undefined && Predicate.isTagged(ws, "Worksheet"), "a worksheet");
    return ws;
  });

/** A one-cell sheet holding `cell`. */
const oneCell = (cell: CellRichText) => trustAs<XlsxFeature>(document([worksheet("S", [[cell]])]));

/** A workbook whose first cell is shared string 0, with `si` as that string. */
const workbookWith = (si: string) =>
  Effect.gen(function* () {
    const written = bytesOf(
      yield* makeXlsxWriter().write(trustAs<XlsxFeature>(document([worksheet("S", [["x"]])]))),
    );
    return withSst(
      written,
      `<?xml version="1.0" encoding="UTF-8"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="1" uniqueCount="1"><si>${si}</si></sst>`,
    );
  });

describe("XLSX rich shared strings (#66)", () => {
  it.effect("round-trip the marks, keeping the space between runs", () =>
    Effect.gen(function* () {
      const rich = new CellRichText({
        runs: [
          str("Hello"),
          str(" "),
          strong([str("bold")]),
          str(" and "),
          emph([underline([str("both")])]),
          subscript([str("2")]),
        ],
      });
      const written = bytesOf(yield* makeXlsxWriter().write(oneCell(rich)));
      const sst = sstOf(written);
      expect(sst).toContain('<r><t xml:space="preserve">Hello </t></r>');
      expect(sst).toContain('<r><rPr><b/></rPr><t xml:space="preserve">bold</t></r>');
      expect(sst).toContain('<r><rPr><i/><u/></rPr><t xml:space="preserve">both</t></r>');
      expect(sst).toContain(
        '<r><rPr><vertAlign val="subscript"/></rPr><t xml:space="preserve">2</t></r>',
      );
      const [cell] = rowCellsOf((yield* firstSheet(written)).rows[0] ?? []);
      assert(Predicate.isTagged(cell, "CellRichText"), "a rich cell");
      // the reader's nesting is canonical: bold outermost, then italic, underline, strike, vertAlign
      expect(cell.runs).toEqual([
        str("Hello"),
        expect.objectContaining({ _tag: "Space" }),
        strong([str("bold")]),
        expect.objectContaining({ _tag: "Space" }),
        str("and"),
        expect.objectContaining({ _tag: "Space" }),
        emph([underline([str("both")])]),
        subscript([str("2")]),
      ]);
    }),
  );

  it.effect(
    'Excel\'s runs: val="0" turns a mark off, u="none" is no underline, and fonts are not marks',
    () =>
      Effect.gen(function* () {
        const data = yield* workbookWith(
          '<r><rPr><b val="0"/><sz val="11"/><rFont val="Calibri"/></rPr><t>plain </t></r>' +
            '<r><rPr><b/><u val="none"/><color rgb="FFFF0000"/></rPr><t>red bold</t></r>',
        );
        const [cell] = rowCellsOf((yield* firstSheet(data)).rows[0] ?? []);
        assert(Predicate.isTagged(cell, "CellRichText"), "a rich cell");
        expect(cell.runs.at(-1)).toEqual(
          strong([str("red"), expect.objectContaining({ _tag: "Space" }), str("bold")]),
        );
      }),
  );

  it.effect("runs none of which is marked read as plain text, phonetic guides left out", () =>
    Effect.gen(function* () {
      const data = yield* workbookWith(
        '<r><t>ab</t></r><r><rPr><sz val="9"/></rPr><t>cd</t></r><rPh sb="0" eb="1"><t>x</t></rPh>',
      );
      expect(rowCellsOf((yield* firstSheet(data)).rows[0] ?? [])).toEqual(["abcd"]);
    }),
  );

  it.effect("identical rich strings share one entry", () =>
    Effect.gen(function* () {
      const rich = new CellRichText({ runs: [strong([str("same")])] });
      const doc = trustAs<XlsxFeature>(document([worksheet("S", [[rich, rich]])]));
      const sst = sstOf(bytesOf(yield* makeXlsxWriter().write(doc)));
      expect(sst).toContain('count="2" uniqueCount="1"');
    }),
  );
});
