/**
 * The DOCX reader and writer against mammoth (the most used DOCX reader in
 * JavaScript) and `docx` (the most used DOCX writer), on prose documents of
 * headings, styled paragraphs, lists and tables (`prose.ts`).
 *
 * - **read**: document bytes to content (`makeDocxReader().read`, against
 *   mammoth's `convertToHtml` and `extractRawText`), all reading the file our
 *   writer wrote.
 * - **write**: content to document bytes (`makeDocxWriter().write`, against
 *   `docx`'s `Packer.toBuffer` of the same paragraphs, without the lists and
 *   tables).
 *
 * Run with `vp run bench:docx` (builds first).
 */
import { bytes, contentToBytes, narrow } from "@thomasfosterau/effect-document";
import { Docx } from "@thomasfosterau/effect-ooxml";
import * as DocxLib from "docx";
import * as Effect from "effect/Effect";
import mammoth from "mammoth";
import { type Group, runGroups } from "./harness.ts";
import { proseDocument, proseParagraphs } from "./prose.ts";

const run = <A, E>(effect: Effect.Effect<A, E>): A => Effect.runSync(effect);
const reader = Docx.makeDocxReader();
const writer = Docx.makeDocxWriter();

const groups = (name: string, sections: number): Array<Group> => {
  const doc = narrow(proseDocument(sections), Docx.Docx).document;
  const written = run(writer.write(doc));
  const file = contentToBytes(written);
  const arrayBuffer = file.slice().buffer;
  const paragraphs = proseParagraphs(sections);
  const docxLib = () =>
    new DocxLib.Document({
      sections: [
        {
          children: paragraphs.map(
            (p, i) =>
              new DocxLib.Paragraph(
                i % 4 === 0
                  ? { text: p, heading: DocxLib.HeadingLevel.HEADING_2 }
                  : {
                      children: [
                        new DocxLib.TextRun(p),
                        new DocxLib.TextRun({ text: " bold", bold: true }),
                      ],
                    },
              ),
          ),
        },
      ],
    });
  return [
    {
      name: `read: ${name}`,
      bytes: file.length,
      cases: [
        { name: "effect-ooxml read", run: () => run(reader.read(bytes(file))) },
        { name: "mammoth convertToHtml", run: () => mammoth.convertToHtml({ arrayBuffer }) },
        { name: "mammoth extractRawText", run: () => mammoth.extractRawText({ arrayBuffer }) },
      ],
    },
    {
      name: `write: ${name}`,
      bytes: file.length,
      cases: [
        { name: "effect-ooxml write (document)", run: () => run(writer.write(doc)) },
        {
          name: "docx Packer.toBuffer (paragraphs)",
          run: () => DocxLib.Packer.toBuffer(docxLib()),
        },
      ],
    },
  ];
};

await runGroups("DOCX", [...groups("500 sections", 500), ...groups("20 sections", 20)]);
