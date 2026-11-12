/**
 * Format detection (#188): `detect` ranks the right format first for every
 * format's own output and every fixture, a file name only breaks ties, and
 * nothing a sniffer meets makes detection fail.
 */

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import { assert, describe, expect, test } from "vite-plus/test";
import {
  bytes,
  cell,
  type Content,
  detect,
  type DetectHints,
  type Doc,
  document,
  header,
  para,
  slide,
  slideShow,
  str,
  text,
  textBox,
  trustAs,
  worksheet,
  type WriteError,
} from "@thomasfosterau/effect-document";
import * as Csv from "@thomasfosterau/effect-document/csv";
import { Keynote, Numbers, Pages } from "@thomasfosterau/effect-document/iwork";
import { Docx, Pptx, Xlsx } from "@thomasfosterau/effect-document/ooxml";
import * as Pdf from "@thomasfosterau/effect-document/pdf";
import * as Rtf from "@thomasfosterau/effect-document/rtf";

/** What the throwing sniffer throws. */
class Boom extends Schema.TaggedError<Boom>()("Boom", {}) {}

const FORMATS = [
  Csv.format,
  Csv.tsvFormat,
  Xlsx.format,
  Docx.format,
  Pptx.format,
  Pdf.format,
  Rtf.format,
  Numbers.format,
  Pages.format,
  Keynote.format,
];

/** The id of the format `detect` ranks first, or "nothing". */
const best = (content: Content, hints?: DetectHints): string =>
  Effect.runSync(
    Effect.map(
      detect(content, { formats: FORMATS, hints }),
      ([first]) => first?.format.id ?? "nothing",
    ),
  );

/** What `format`'s writer makes of `doc`. */
const writeWith = (
  format: {
    readonly writer?:
      | { readonly write: (d: Doc<never>) => Effect.Effect<Content, WriteError> }
      | undefined;
  },
  doc: Doc<never>,
): Content => {
  const writer = format.writer;
  assert(writer !== undefined, "the format writes");
  return Effect.runSync(writer.write(doc));
};
const prose = trustAs<never>(document([header(1, [str("Title")]), para([str("Body text.")])]));
const sheet = trustAs<never>(
  document([
    worksheet("S", [
      [cell.text("name"), cell.text("n")],
      [cell.text("a"), cell.number(1)],
    ]),
  ]),
);
const deck = trustAs<never>(document([slideShow([slide([textBox([para([str("Hi")])])])])]));

/** What each format writes, which its own sniffer must recognise. */
const WRITTEN: ReadonlyArray<readonly [string, () => Content]> = [
  ["csv", () => writeWith(Csv.format, sheet)],
  ["tsv", () => writeWith(Csv.tsvFormat, sheet)],
  ["xlsx", () => writeWith(Xlsx.format, sheet)],
  ["docx", () => writeWith(Docx.format, prose)],
  ["pptx", () => writeWith(Pptx.format, deck)],
  ["pdf", () => writeWith(Pdf.format, prose)],
  ["rtf", () => writeWith(Rtf.format, prose)],
];

/** A fixture's bytes. */
const fixture = (path: string): Promise<Content> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      return bytes(
        yield* fs.readFile(new URL(`../../packages/core/test/${path}`, import.meta.url).pathname),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

describe("detect (#188)", () => {
  test.each(WRITTEN)("%s output is detected as %s", (id, written) => {
    expect(best(written())).toBe(id);
  });

  test.each([
    ["iwork/fixtures/simple-oneslide.key", "keynote"],
    ["iwork/fixtures/test-1.numbers", "numbers"],
    ["pdf/fixtures/libreoffice.pdf", "pdf"],
    ["pdf/fixtures/reportlab.pdf", "pdf"],
  ])("the fixture %s is detected as %s", async (path, id) => {
    expect(best(await fixture(path))).toBe(id);
  });

  test("a PDF without its header is still a PDF, as the reader reads it (#173)", async () => {
    const written = writeWith(Pdf.format, prose);
    assert(Predicate.isTagged(written, "Bytes"), "the PDF writer writes bytes");
    // cut everything before the first object definition: the header and its binary comment
    const latin1 = new TextDecoder("latin1").decode(written.bytes);
    const headerless = bytes(written.bytes.subarray(latin1.search(/\d+ \d+ obj\b/)));
    expect(best(headerless)).toBe("pdf");
    const doc = await Effect.runPromise(Pdf.makePdfReader().read(headerless));
    expect(doc.blocks.length).toBeGreaterThan(0);
  });

  test("a misleading file name never outranks the content", () => {
    const xlsx = writeWith(Xlsx.format, sheet);
    expect(best(xlsx, { fileName: "export.csv", mimeType: "text/csv" })).toBe("xlsx");
    const docx = writeWith(Docx.format, prose);
    expect(best(docx, { fileName: "notes.xlsx" })).toBe("docx");
  });

  test("a file name breaks a tie between equally sure sniffers", () => {
    // one column of text: CSV and TSV are equally (un)sure
    expect(best(text("a\nb\nc\n"), { fileName: "list.tsv" })).toBe("tsv");
    expect(best(text("a\nb\nc\n"), { fileName: "list.csv" })).toBe("csv");
  });

  test("each candidate carries its evidence, most likely first", () => {
    const candidates = Effect.runSync(
      detect(writeWith(Xlsx.format, sheet), {
        formats: FORMATS,
        hints: { fileName: "book.xlsx" },
      }),
    );
    expect(candidates.map((c) => c.format.id)).toEqual(["xlsx"]);
    expect(candidates[0]?.evidence).toContain("xl/workbook.xml");
    expect(candidates[0]?.evidence).toContain("extension .xlsx");
  });

  test("binary garbage matches nothing, and a throwing sniffer is a no", () => {
    expect(best(bytes(new Uint8Array([0, 1, 2, 0xff, 0, 7])))).toBe("nothing");
    expect(best(bytes(new Uint8Array([0x50, 0x4b, 3, 4, 0, 0])))).toBe("nothing");
    const throwing = {
      id: "boom",
      sniff: () => {
        throw new Boom();
      },
    };
    const kept = { id: "kept", sniff: () => Option.some({ confidence: 0.5, evidence: "always" }) };
    const ranked = Effect.runSync(detect(text("x"), { formats: [throwing, kept] }));
    expect(ranked.map((c) => c.format.id)).toEqual(["kept"]);
  });
});
