import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import { assert, describe, expect, test } from "vite-plus/test";
import { blocksToText, bytes } from "@thomasfosterau/effect-document";
import {
  OcrEngine,
  type OcrEngineShape,
  OcrError,
  type OcrImage,
  type OcrWord,
  PdfOcrReaderLive,
  PdfReaderTag,
  makePdfReader,
  ocrGlyphs,
} from "../src/index.ts";
import {
  PdfBuilder,
  type PdfObject,
  latin1ToBytes,
  pdfArray,
  pdfDict,
  pdfName,
  pdfStream,
} from "../src/cos/index.ts";
import { flateEncode } from "../src/cos/filters.ts";

/** A one-page PDF (612 × 792) with the given content stream and resources. */
const onePage = (content: string, resources: Record<string, PdfObject>): Uint8Array => {
  const pdf = new PdfBuilder();
  const pages = pdf.alloc();
  const contents = pdf.add(pdfStream(pdfDict(), latin1ToBytes(content)));
  const page = pdf.add(
    pdfDict({
      Type: pdfName("Page"),
      Parent: pages,
      MediaBox: pdfArray([0, 0, 612, 792]),
      Contents: contents,
      Resources: pdfDict(resources),
    }),
  );
  pdf.set(pages, pdfDict({ Type: pdfName("Pages"), Kids: pdfArray([page]), Count: 1 }));
  return pdf.build({ root: pdf.add(pdfDict({ Type: pdfName("Catalog"), Pages: pages })) });
};

/** An image XObject with the given extra dictionary entries over `data`. */
const image = (
  width: number,
  height: number,
  entries: Record<string, PdfObject>,
  data: Uint8Array,
): PdfObject =>
  pdfStream(
    pdfDict({
      Type: pdfName("XObject"),
      Subtype: pdfName("Image"),
      Width: width,
      Height: height,
      ...entries,
    }),
    data,
  );

/** A 100 × 100 8-bit gray image, Flate-compressed. */
const grayImage = image(
  100,
  100,
  { ColorSpace: pdfName("DeviceGray"), BitsPerComponent: 8, Filter: pdfName("FlateDecode") },
  flateEncode(new Uint8Array(100 * 100).fill(255)),
);

/** A page that paints `im` over its whole area, and nothing else. */
const scan = (im: PdfObject, extra = ""): Uint8Array =>
  onePage(`q 612 0 0 792 0 0 cm /Im1 Do Q ${extra}`, {
    XObject: pdfDict({ Im1: im }),
    Font: pdfDict({
      F1: pdfDict({
        Type: pdfName("Font"),
        Subtype: pdfName("Type1"),
        BaseFont: pdfName("Helvetica"),
        Encoding: pdfName("WinAnsiEncoding"),
      }),
    }),
  });

/** An engine that records the images it is given and answers with `words`. */
const fakeEngine = (words: ReadonlyArray<OcrWord>) => {
  const seen: OcrImage[] = [];
  const engine: OcrEngineShape = {
    recognize: (img) =>
      Effect.sync(() => {
        seen.push(img);
        return words;
      }),
  };
  return { engine, seen };
};

const word = (text: string, left: number, top: number, right: number, bottom: number): OcrWord => ({
  text,
  left,
  top,
  right,
  bottom,
});

/** Two words on one line near the top of a 100 × 100 image, and a line well below. */
const WORDS = [
  word("Hello", 10, 10, 30, 14),
  word("world", 33, 10, 55, 14),
  word("Second", 10, 40, 40, 44),
];

describe("pages without a text layer (#31)", () => {
  test("a scanned page reads as empty and is listed in pagesWithoutText", () => {
    const back = Effect.runSync(makePdfReader().read(bytes(scan(grayImage))));
    expect(back.blocks).toEqual([]);
    expect(back.meta.pagesWithoutText).toEqual([1]);
  });

  test("a page with text is not listed, even with an image on it", () => {
    const back = Effect.runSync(
      makePdfReader().read(bytes(scan(grayImage, "BT /F1 12 Tf 72 700 Td (Caption) Tj ET"))),
    );
    expect(blocksToText(back.blocks)).toBe("Caption");
    expect(back.meta.pagesWithoutText).toBeUndefined();
  });

  test("a page with neither text nor images is not listed", () => {
    const back = Effect.runSync(makePdfReader().read(bytes(onePage("", {}))));
    expect(back.meta.pagesWithoutText).toBeUndefined();
  });
});

describe("OCR engine (#31)", () => {
  test("recognised words become the page's text, line by line", () => {
    const { engine, seen } = fakeEngine(WORDS);
    const back = Effect.runSync(makePdfReader({ ocr: engine }).read(bytes(scan(grayImage))));
    expect(back.blocks.map((b) => blocksToText([b]))).toEqual(["Hello world", "Second"]);
    expect(back.meta.pagesWithoutText).toBeUndefined();
    expect(seen).toHaveLength(1);
    const [img] = seen;
    assert(img !== undefined && Predicate.isTagged(img, "Samples"));
    expect([img.width, img.height, img.components, img.bitsPerComponent, img.mask]).toEqual([
      100,
      100,
      1,
      8,
      false,
    ]);
    // the Flate filter is undone, so the engine gets the samples themselves
    expect(img.data.length).toBe(100 * 100);
  });

  test("pages with text are never sent to the engine", () => {
    const { engine, seen } = fakeEngine(WORDS);
    Effect.runSync(
      makePdfReader({ ocr: engine }).read(
        bytes(scan(grayImage, "BT /F1 12 Tf 72 700 Td (Caption) Tj ET")),
      ),
    );
    expect(seen).toEqual([]);
  });

  test("a page the engine finds nothing on stays in pagesWithoutText", () => {
    const { engine } = fakeEngine([]);
    const back = Effect.runSync(makePdfReader({ ocr: engine }).read(bytes(scan(grayImage))));
    expect(back.meta.pagesWithoutText).toEqual([1]);
  });

  test("JPEG data is passed through as it is stored", () => {
    const jpeg = Uint8Array.of(0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9);
    const { engine, seen } = fakeEngine(WORDS);
    Effect.runSync(
      makePdfReader({ ocr: engine }).read(
        bytes(
          scan(
            image(
              100,
              100,
              {
                ColorSpace: pdfName("DeviceRGB"),
                BitsPerComponent: 8,
                Filter: pdfName("DCTDecode"),
              },
              jpeg,
            ),
          ),
        ),
      ),
    );
    const [img] = seen;
    assert(img !== undefined && Predicate.isTagged(img, "Encoded"));
    expect(img.codec).toBe("jpeg");
    expect(img.data).toEqual(jpeg);
  });

  test("CCITT images carry their decode parameters", () => {
    const { engine, seen } = fakeEngine([]);
    Effect.runSync(
      makePdfReader({ ocr: engine }).read(
        bytes(
          scan(
            image(
              100,
              100,
              {
                ImageMask: true,
                Filter: pdfArray([pdfName("CCITTFaxDecode")]),
                DecodeParms: pdfArray([pdfDict({ K: -1, Columns: 100, BlackIs1: true })]),
              },
              Uint8Array.of(0, 1, 2),
            ),
          ),
        ),
      ),
    );
    const [img] = seen;
    assert(img !== undefined && Predicate.isTagged(img, "Encoded"));
    expect(img.codec).toBe("ccitt");
    expect(img.parameters).toEqual({ K: -1, Columns: 100, BlackIs1: true });
    expect(Option.isNone(img.globals)).toBe(true);
  });

  test("JBIG2 images carry their decoded globals", () => {
    const { engine, seen } = fakeEngine([]);
    const globals = pdfStream(
      pdfDict({ Filter: pdfName("FlateDecode") }),
      flateEncode(Uint8Array.of(7, 8, 9)),
    );
    Effect.runSync(
      makePdfReader({ ocr: engine }).read(
        bytes(
          scan(
            image(
              100,
              100,
              {
                ColorSpace: pdfName("DeviceGray"),
                BitsPerComponent: 1,
                Filter: pdfName("JBIG2Decode"),
                DecodeParms: pdfDict({ JBIG2Globals: globals }),
              },
              Uint8Array.of(0, 1, 2),
            ),
          ),
        ),
      ),
    );
    const [img] = seen;
    assert(img !== undefined && Predicate.isTagged(img, "Encoded"));
    expect(img.codec).toBe("jbig2");
    expect(Option.getOrUndefined(img.globals)).toEqual(Uint8Array.of(7, 8, 9));
  });

  test("inline images are recognised too", () => {
    const { engine, seen } = fakeEngine(WORDS);
    const content =
      "q 612 0 0 792 0 0 cm BI /W 4 /H 2 /CS /G /BPC 8 ID \xff\xff\xff\xff\x00\x00\x00\x00 EI Q";
    const back = Effect.runSync(makePdfReader({ ocr: engine }).read(bytes(onePage(content, {}))));
    const [img] = seen;
    assert(img !== undefined && Predicate.isTagged(img, "Samples"));
    expect([img.width, img.height, img.components]).toEqual([4, 2, 1]);
    expect(blocksToText(back.blocks)).toContain("Hello world");
  });

  test("an image in a colour space no engine can take is skipped", () => {
    const { engine, seen } = fakeEngine(WORDS);
    const indexed = image(
      2,
      2,
      {
        ColorSpace: pdfArray([
          pdfName("Indexed"),
          pdfName("DeviceRGB"),
          1,
          latin1ToBytes("\0\0\0\xff\xff\xff").length,
        ]),
        BitsPerComponent: 8,
      },
      Uint8Array.of(0, 1, 1, 0),
    );
    const back = Effect.runSync(makePdfReader({ ocr: engine }).read(bytes(scan(indexed))));
    expect(seen).toEqual([]);
    expect(back.meta.pagesWithoutText).toEqual([1]);
  });

  test("a truncated image is skipped rather than handed over short", () => {
    const { engine, seen } = fakeEngine(WORDS);
    const short = image(
      100,
      100,
      { ColorSpace: pdfName("DeviceGray"), BitsPerComponent: 8 },
      new Uint8Array(10),
    );
    Effect.runSync(makePdfReader({ ocr: engine }).read(bytes(scan(short))));
    expect(seen).toEqual([]);
  });

  test("an engine failure fails the read with a ParseError naming the page", () => {
    const engine: OcrEngineShape = {
      recognize: () => Effect.fail(new OcrError({ reason: "engine crashed" })),
    };
    const error = Effect.runSync(
      Effect.flip(makePdfReader({ ocr: engine }).read(bytes(scan(grayImage)))),
    );
    expect(error.reason).toBe("OCR failed on page 1: engine crashed");
    expect(error.cause).toBeInstanceOf(OcrError);
  });

  test("PdfOcrReaderLive builds the reader from the OcrEngine service", () => {
    const { engine } = fakeEngine(WORDS);
    const program = Effect.flatMap(PdfReaderTag, (reader) => reader.read(bytes(scan(grayImage))));
    const back = Effect.runSync(
      Effect.provide(
        program,
        PdfOcrReaderLive.pipe(Layer.provide(Layer.succeed(OcrEngine, engine))),
      ),
    );
    expect(back.blocks.map((b) => blocksToText([b]))).toEqual(["Hello world", "Second"]);
  });
});

describe("ocrGlyphs", () => {
  const FULL_PAGE = [612, 0, 0, 792, 0, 0] as const;

  test("places a line by the image's matrix, origin flipped to the bottom", () => {
    const [glyph] = ocrGlyphs([word("Hi", 10, 10, 30, 20)], FULL_PAGE, 100, 100);
    assert(glyph !== undefined);
    expect(glyph.text).toBe("Hi");
    expect(glyph.x).toBeCloseTo(61.2);
    expect(glyph.y).toBeCloseTo(792 * 0.8);
    expect(glyph.width).toBeCloseTo(612 * 0.2);
    expect(glyph.size).toBeCloseTo(79.2);
    expect(glyph.upright).toBe(true);
  });

  test("a word starting well before the line ends starts a new line (a new column)", () => {
    const glyphs = ocrGlyphs(
      [word("left", 50, 10, 90, 20), word("right", 5, 10, 40, 20)],
      FULL_PAGE,
      100,
      100,
    );
    expect(glyphs.map((g) => g.text)).toEqual(["left", "right"]);
  });

  test("blank and zero-height words are dropped", () => {
    const glyphs = ocrGlyphs(
      [word(" ", 10, 10, 20, 20), word("flat", 10, 10, 20, 10), word("ok", 30, 10, 40, 20)],
      FULL_PAGE,
      100,
      100,
    );
    expect(glyphs.map((g) => g.text)).toEqual(["ok"]);
  });

  test("text on a rotated image is not upright", () => {
    const [glyph] = ocrGlyphs([word("Hi", 10, 10, 30, 20)], [0, 612, -792, 0, 792, 0], 100, 100);
    expect(glyph?.upright).toBe(false);
  });
});
