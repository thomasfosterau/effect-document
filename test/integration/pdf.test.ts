import { it } from "@effect/vitest";
import { describe, expect } from "vite-plus/test";
import * as Effect from "effect/Effect";
import {
  blocksToText,
  bulletList,
  convert,
  document,
  header,
  link,
  para,
  plainText,
  str,
  strong,
  table,
  trustAs,
  type FeaturesOf,
} from "@thomasfosterau/effect-document";
import { Docx } from "@thomasfosterau/effect-document/ooxml";
import * as Pdf from "@thomasfosterau/effect-document/pdf";
import * as Rtf from "@thomasfosterau/effect-document/rtf";

const report = trustAs<FeaturesOf<typeof Docx.profile>>(
  document([
    header(1, [str("Report")]),
    para([
      str("See "),
      link([str("the site")], "https://example.com"),
      str(" for "),
      strong([str("details")]),
      str("."),
    ]),
    bulletList([[plainText("first")], [plainText("second")]]),
    table({ headers: ["A", "B"], rows: [[[plainText("1")], [plainText("2")]]] }),
  ]),
);
const docxBytes = () =>
  Effect.gen(function* () {
    return yield* Docx.makeDocxWriter().write(report);
  });

describe("DOCX -> PDF (narrowing)", () => {
  it.effect(
    "keeps headings, links, lists and styling; turns the table into paragraphs and says so",
    () =>
      Effect.gen(function* () {
        const { content, loss } = yield* convert({
          from: Docx.format,
          to: Pdf.format,
          input: yield* docxBytes(),
        });
        expect(
          loss.entries.filter((e) => e.feature === "block.table").map((e) => e.action),
        ).toEqual(["converted"]);
        const back = yield* Pdf.makePdfReader().read(content);
        expect(Pdf.Pdf.is(back)).toBe(true);
        // the table's rows come back as paragraphs (#111)
        expect(back.blocks.map((b) => b._tag)).toEqual([
          "Header",
          "Para",
          "BulletList",
          "Para",
          "Para",
        ]);
        expect(blocksToText(back.blocks)).toContain("See the site for details.");
        expect(blocksToText(back.blocks)).toContain("1 2");
      }),
  );
});

describe("PDF -> DOCX (widening)", () => {
  it.effect("is lossless because the PDF profile is a subset of DOCX", () =>
    Effect.gen(function* () {
      const pdf = yield* Pdf.makePdfWriter().write(
        trustAs<FeaturesOf<typeof Pdf.profile>>(
          document([header(1, [str("Title")]), para([str("plain "), strong([str("bold")])])]),
        ),
      );
      const { content, loss } = yield* convert({ from: Pdf.format, to: Docx.format, input: pdf });
      expect(loss.isLossless).toBe(true);
      const back = yield* Docx.makeDocxReader().read(content);
      expect(blocksToText(back.blocks)).toContain("plain bold");
    }),
  );
});

describe("RTF -> PDF (widening)", () => {
  it.effect("is lossless and round-trips the text", () =>
    Effect.gen(function* () {
      const rtf = yield* Rtf.makeRtfWriter().write(
        trustAs<FeaturesOf<typeof Rtf.profile>>(document([para([str("from RTF")])])),
      );
      const { content, loss } = yield* convert({ from: Rtf.format, to: Pdf.format, input: rtf });
      expect(loss.isLossless).toBe(true);
      expect(blocksToText((yield* Pdf.makePdfReader().read(content)).blocks)).toBe("from RTF");
    }),
  );
});
