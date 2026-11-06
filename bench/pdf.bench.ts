/**
 * The PDF reader and writer against pdf.js (Mozilla's, the reference PDF
 * reader in JavaScript) and PDFKit (the most used maintained PDF writer;
 * pdf-lib has not been published since 2021), on prose
 * documents of headings, styled paragraphs and lists (`prose.ts`, narrowed
 * to what the PDF writer encodes).
 *
 * - **read**: PDF bytes to text and structure (`makePdfReader().read`, which
 *   lays the text out into paragraphs, headings and lists, against pdf.js's
 *   `getTextContent` on every page, which returns positioned text runs
 *   only), all reading the file our writer wrote, and the LibreOffice and
 *   ReportLab fixtures.
 * - **write**: content to PDF bytes (`makePdfWriter().write`, which lays the
 *   document out, against PDFKit laying out the same paragraphs, wrapped and
 *   paginated by PDFKit, in a standard font).
 *
 * Run with `vp run bench:pdf` (builds first).
 */
import { readFileSync } from "node:fs";
import { bytes, contentToBytes, narrow } from "@thomasfosterau/effect-document";
import { makePdfReader, makePdfWriter, PdfWrite } from "@thomasfosterau/effect-document/pdf";
import * as Effect from "effect/Effect";
import { Buffer } from "node:buffer";
import PDFKitDocument from "pdfkit";
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
  { name: "effect-document read", run: () => run(reader.read(bytes(file))) },
  { name: "pdf.js getTextContent (all pages)", run: () => pdfjsText(file) },
];

/**
 * PDFKit: the paragraphs in Helvetica, laid out (wrapped and paginated) by
 * PDFKit itself, collected from its output stream.
 */
const pdfkitWrite = (paragraphs: ReadonlyArray<string>): Promise<Uint8Array> =>
  new Promise((resolve, reject) => {
    const pdf = new PDFKitDocument({ size: "A4", margin: 72 });
    const chunks: Array<Uint8Array> = [];
    pdf.on("data", (chunk: Uint8Array) => chunks.push(chunk));
    pdf.on("end", () => resolve(Buffer.concat(chunks)));
    pdf.on("error", reject);
    pdf.font("Helvetica").fontSize(11);
    for (const paragraph of paragraphs) pdf.text(paragraph, { paragraphGap: 11 });
    pdf.end();
  });

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
        { name: "effect-document write (document)", run: () => run(writer.write(doc)) },
        { name: "PDFKit text (paragraphs)", run: () => pdfkitWrite(paragraphs) },
      ],
    },
  ];
};

const fixture = (name: string): Group => {
  const file = new Uint8Array(
    readFileSync(new URL(`../packages/core/test/pdf/fixtures/${name}`, import.meta.url)),
  );
  return { name: `read: ${name} (fixture)`, bytes: file.length, cases: readCases(file) };
};

await runGroups("PDF", [
  ...groups("200 sections", 200),
  ...groups("10 sections", 10),
  fixture("libreoffice.pdf"),
  fixture("reportlab.pdf"),
]);
