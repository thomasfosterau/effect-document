/**
 * The document outline (#20, slice 3 of #198): the writer builds one from the
 * headings, and the layout reader takes heading levels from it.
 */

import * as Predicate from "effect/Predicate";
import * as Effect from "effect/Effect";
import { assert, describe, expect, test } from "vite-plus/test";
import {
  type Block,
  bytes,
  document,
  header,
  para,
  str,
  trustAs,
} from "@thomasfosterau/effect-document";
import { type PdfFeature, makePdfReader, makePdfWriter } from "../src/index.ts";
import {
  PdfBuilder,
  PdfFile,
  type PdfDict,
  type PdfObject,
  type PdfRef,
  isRef,
  latin1ToBytes,
  pdfArray,
  pdfDict,
  pdfName,
  pdfStream,
  pdfTextString,
} from "../src/cos/index.ts";
import { readOutline } from "../src/text/outline.ts";

const write = (blocks: ReadonlyArray<Block>): Uint8Array => {
  const c = Effect.runSync(makePdfWriter().write(trustAs<PdfFeature>(document(blocks))));
  assert(Predicate.isTagged(c, "Bytes"));
  return c.bytes;
};

const read = (data: Uint8Array) => Effect.runSync(makePdfReader().read(bytes(data)));

describe("the writer's outline (#20)", () => {
  test("has an item per heading, nested by level, going to its page", () => {
    const filler = para([str(Array.from({ length: 700 }, (_, i) => `w${i}`).join(" "))]);
    const file = PdfFile.open(
      write([
        header(1, [str("One")]),
        header(3, [str("One.a")]),
        header(2, [str("One.b")]),
        filler,
        header(1, [str("Two")]),
        para([str("no heading")]),
      ]),
    );
    expect(readOutline(file)).toEqual([
      { title: "One", depth: 1 },
      { title: "One.a", depth: 2 },
      { title: "One.b", depth: 2 },
      { title: "Two", depth: 1 },
    ]);
    const outlines = file.lookupDict(file.catalog, "Outlines");
    expect(file.lookupNumber(outlines, "Count")).toBe(4);
    const one = file.lookupDict(outlines, "First");
    expect(file.lookupNumber(one, "Count")).toBe(2);
    // "Two" is on the second page, after the filler
    const two = file.lookupDict(outlines, "Last");
    const dest = file.lookupArray(two, "Dest")?.items ?? [];
    const pages = file.pages();
    expect(pages.length).toBeGreaterThan(1);
    const target = dest[0];
    assert(isRef(target));
    expect(pages.findIndex((p) => p.ref?.num === target.num)).toBe(pages.length - 1);
    expect(dest[1]).toEqual(pdfName("XYZ"));
  });

  test("a document without headings has no outline", () => {
    const file = PdfFile.open(write([para([str("x")])]));
    expect(file.catalog.entries.has("Outlines")).toBe(false);
  });
});

/** An untagged one-page PDF with the given content and outline items (title, depth). */
const untagged = (
  content: string,
  outline: (pdf: PdfBuilder, parent: PdfRef) => ReadonlyArray<PdfRef>,
): Uint8Array => {
  const pdf = new PdfBuilder();
  const pages = pdf.alloc();
  const font = pdf.add(
    pdfDict({
      Type: pdfName("Font"),
      Subtype: pdfName("Type1"),
      BaseFont: pdfName("Helvetica"),
      Encoding: pdfName("WinAnsiEncoding"),
    }),
  );
  const page = pdf.add(
    pdfDict({
      Type: pdfName("Page"),
      Parent: pages,
      MediaBox: pdfArray([0, 0, 612, 792]),
      Contents: pdf.add(pdfStream(pdfDict(), latin1ToBytes(content))),
      Resources: pdfDict({ Font: pdfDict({ F: font }) }),
    }),
  );
  pdf.set(pages, pdfDict({ Type: pdfName("Pages"), Kids: pdfArray([page]), Count: 1 }));
  const root = pdf.alloc();
  const items = outline(pdf, root);
  pdf.set(
    root,
    pdfDict({ Type: pdfName("Outlines"), First: items[0], Last: items[items.length - 1] }),
  );
  return pdf.build({
    root: pdf.add(pdfDict({ Type: pdfName("Catalog"), Pages: pages, Outlines: root })),
  });
};

const text = (size: number, y: number, s: string): string =>
  `BT /F ${size} Tf 72 ${y} Td (${s}) Tj ET`;

const body = text(11, 640, "Body text that is set in the most common size of all, by far.");

/** An outline item dictionary. */
const outlineItem = (title: string, entries: Record<string, PdfObject | undefined>): PdfDict =>
  pdfDict({ Title: pdfTextString(title), ...entries });

describe("reading heading levels from the outline (#20)", () => {
  test("an untagged file's headings take the outline's depth, not their size rank", () => {
    const data = untagged(
      [text(20, 720, "Chapter"), text(16, 690, "Section"), body].join("\n"),
      (pdf, parent) => {
        const chapter = pdf.alloc();
        const section = pdf.add(outlineItem("Section", { Parent: chapter }));
        pdf.set(chapter, outlineItem("Chapter", { Parent: parent, First: section, Last: section }));
        const top = pdf.add(outlineItem("Book", { Parent: parent, First: chapter, Last: chapter }));
        return [top];
      },
    );
    const levels = read(data).blocks.flatMap((b) =>
      Predicate.isTagged(b, "Header") ? [b.level] : [],
    );
    expect(levels).toEqual([2, 3]);
  });

  test("a heading missing from the outline is ranked by size", () => {
    const data = untagged(
      [text(20, 720, "Chapter"), text(16, 690, "Section"), body].join("\n"),
      (pdf, parent) => [pdf.add(outlineItem("Elsewhere", { Parent: parent }))],
    );
    const levels = read(data).blocks.flatMap((b) =>
      Predicate.isTagged(b, "Header") ? [b.level] : [],
    );
    expect(levels).toEqual([1, 2]);
  });

  test("a cyclic outline ends", () => {
    const data = untagged(body, (pdf, parent) => {
      const a = pdf.alloc();
      const b = pdf.add(outlineItem("B", { Parent: parent, Next: a }));
      pdf.set(a, outlineItem("A", { Parent: parent, Next: b, First: a }));
      return [a];
    });
    const file = PdfFile.open(data);
    expect(readOutline(file)).toEqual([
      { title: "A", depth: 1 },
      { title: "B", depth: 1 },
    ]);
    expect(read(data).blocks.length).toBe(1);
  });
});
