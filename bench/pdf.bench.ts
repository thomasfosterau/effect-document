/**
 * The PDF reader and writer against pdf.js (Mozilla's, the reference PDF
 * reader in JavaScript) and pdf-lib (the most used PDF writer), on prose
 * documents of headings, styled paragraphs and lists (`prose.ts`, narrowed
 * to what the PDF writer encodes).
 *
 * - **read**: PDF bytes to text and structure (`makePdfReader().read`, which
 *   lays the text out into paragraphs, headings and lists, against pdf.js's
 *   `getTextContent` on every page, which returns positioned text runs
 *   only), all reading the file our writer wrote, and the LibreOffice and
 *   ReportLab fixtures.
 * - **write**: content to PDF bytes (`makePdfWriter().write`, which lays the
 *   document out, against pdf-lib drawing the same paragraphs a line at a
 *   time, wrapped by hand, in a standard font).
 *
 * Run with `vp run bench:pdf` (builds first).
 */
import { readFileSync } from "node:fs";
import { bytes, contentToBytes, narrow } from "@thomasfosterau/effect-document";
import { makePdfReader, makePdfWriter, PdfWrite } from "@thomasfosterau/effect-pdf";
import * as Effect from "effect/Effect";
import { PDFDocument, StandardFonts } from "pdf-lib";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { type Case, type Group, runGroups } from "./harness.ts";
import { proseDocument, proseParagraphs } from "./prose.ts";

const run = <A, E>(effect: Effect.Effect<A, E>): A => Effect.runSync(effect);
const reader = makePdfReader();
const writer = makePdfWriter();

/** pdf.js's text of every page, as a consumer extracting text does. */
const pdfjsText = async (file: Uint8Array): Promise<number> => {
  // pdf.js takes ownership of (detaches) the buffer it is given
  const task = pdfjs.getDocument({ data: file.slice(), verbosity: 0 });
  const pdf = await task.promise;
  let items = 0;
  for (let n = 1; n <= pdf.numPages; n++) {
    const page = await pdf.getPage(n);
    items += (await page.getTextContent()).items.length;
  }
  await task.destroy();
  return items;
};

const readCases = (file: Uint8Array): Array<Case> => [
  { name: "effect-pdf read", run: () => run(reader.read(bytes(file))) },
  { name: "pdf.js getTextContent (all pages)", run: () => pdfjsText(file) },
];

/** pdf-lib: the paragraphs in Helvetica, wrapped greedily to the page width. */
const pdfLibWrite = async (paragraphs: ReadonlyArray<string>): Promise<Uint8Array> => {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const size = 11;
  const width = 595 - 144;
  let page = pdf.addPage([595, 842]);
  let y = 842 - 72;
  for (const paragraph of paragraphs) {
    let line = "";
    for (const word of paragraph.split(" ")) {
      const next = line === "" ? word : `${line} ${word}`;
      if (font.widthOfTextAtSize(next, size) <= width) {
        line = next;
        continue;
      }
      page.drawText(line, { x: 72, y, size, font });
      y -= size * 1.4;
      if (y < 72) {
        page = pdf.addPage([595, 842]);
        y = 842 - 72;
      }
      line = word;
    }
    page.drawText(line, { x: 72, y, size, font });
    y -= size * 2;
    if (y < 72) {
      page = pdf.addPage([595, 842]);
      y = 842 - 72;
    }
  }
  return pdf.save();
};

const groups = (name: string, sections: number): Array<Group> => {
  const doc = narrow(proseDocument(sections), PdfWrite).document;
  const written = run(writer.write(doc));
  const file = contentToBytes(written);
  const paragraphs = proseParagraphs(sections);
  return [
    { name: `read: ${name}`, bytes: file.length, cases: readCases(file) },
    {
      name: `write: ${name}`,
      bytes: file.length,
      cases: [
        { name: "effect-pdf write (document)", run: () => run(writer.write(doc)) },
        { name: "pdf-lib drawText (paragraphs)", run: () => pdfLibWrite(paragraphs) },
      ],
    },
  ];
};

const fixture = (name: string): Group => {
  const file = new Uint8Array(
    readFileSync(new URL(`../packages/pdf/test/fixtures/${name}`, import.meta.url)),
  );
  return { name: `read: ${name} (fixture)`, bytes: file.length, cases: readCases(file) };
};

await runGroups("PDF", [
  ...groups("200 sections", 200),
  ...groups("10 sections", 10),
  fixture("libreoffice.pdf"),
  fixture("reportlab.pdf"),
]);
