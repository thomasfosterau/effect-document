import { describe, expect, test } from "vite-plus/test";
import { Effect } from "effect";
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
import { Docx } from "@thomasfosterau/effect-ooxml";
import * as Pdf from "@thomasfosterau/effect-pdf";
import * as Rtf from "@thomasfosterau/effect-rtf";

const run = <A, E>(e: Effect.Effect<A, E>): A => Effect.runSync(e);

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
const docxBytes = () => run(Docx.makeDocxWriter().write(report));

describe("DOCX -> PDF (narrowing)", () => {
  test("keeps headings, links, lists and styling; drops the table and says so", () => {
    const { content, loss } = run(
      convert({ from: Docx.format, to: Pdf.format, input: docxBytes() }),
    );
    expect(loss.entries.map((e) => e.feature)).toContain("block.table");
    const back = run(Pdf.makePdfReader().read(content));
    expect(Pdf.Pdf.is(back)).toBe(true);
    expect(back.blocks.map((b) => b._tag)).toEqual(["Header", "Para", "BulletList"]);
    expect(blocksToText(back.blocks)).toContain("See the site for details.");
  });
});

describe("PDF -> DOCX (widening)", () => {
  test("is lossless because the PDF profile is a subset of DOCX", () => {
    const pdf = run(
      Pdf.makePdfWriter().write(
        trustAs<FeaturesOf<typeof Pdf.profile>>(
          document([header(1, [str("Title")]), para([str("plain "), strong([str("bold")])])]),
        ),
      ),
    );
    const { content, loss } = run(convert({ from: Pdf.format, to: Docx.format, input: pdf }));
    expect(loss.isLossless).toBe(true);
    const back = run(Docx.makeDocxReader().read(content));
    expect(blocksToText(back.blocks)).toContain("plain bold");
  });
});

describe("RTF -> PDF (widening)", () => {
  test("is lossless and round-trips the text", () => {
    const rtf = run(
      Rtf.makeRtfWriter().write(
        trustAs<FeaturesOf<typeof Rtf.profile>>(document([para([str("from RTF")])])),
      ),
    );
    const { content, loss } = run(convert({ from: Rtf.format, to: Pdf.format, input: rtf }));
    expect(loss.isLossless).toBe(true);
    expect(blocksToText(run(Pdf.makePdfReader().read(content)).blocks)).toBe("from RTF");
  });
});
