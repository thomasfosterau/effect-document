/**
 * OCR for pages without a text layer (scans, faxes, "print to image").
 *
 * The PDF package bundles no OCR engine. A program that wants scanned pages
 * read supplies one as the {@link OcrEngine} service (an adapter over
 * Tesseract.js, a cloud OCR API, …), and the reader hands it each image a
 * textless page paints. The engine gets the image the way the PDF stores it:
 * JPEG, JPEG 2000, CCITT fax and JBIG2 data as they are, since those are
 * formats OCR engines and image libraries already read, and anything else as
 * decoded samples. The words it finds become positioned text that goes
 * through the same layout pass as text from a real text layer.
 */

import * as Arr from "effect/Array";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Order from "effect/Order";
import * as Predicate from "effect/Predicate";
import * as Rec from "effect/Record";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type { PdfFile } from "./cos/file.ts";
import {
  type PdfDict,
  type PdfObject,
  type PdfStream,
  isArray,
  isName,
  isStream,
} from "./cos/objects.ts";
import type { PageImage, TextGlyph } from "./text/extract.ts";

/** An OCR engine could not recognise an image: why, and the engine's own failure if any. */
export class OcrError extends Schema.TaggedError<OcrError>()("OcrError", {
  reason: Schema.String,
  cause: Schema.optional(Schema.Unknown),
}) {}

/** The image codecs passed to an {@link OcrEngine} still encoded. */
export type OcrCodec = "jpeg" | "jpeg2000" | "ccitt" | "jbig2";

/**
 * An image in a codec the PDF reader does not decode, passed through as the
 * file stores it: a whole JPEG (`jpeg`) or JPEG 2000 (`jpeg2000`) file, or a
 * raw CCITT fax (`ccitt`) or JBIG2 (`jbig2`) stream, whose settings are in
 * `parameters` and, for JBIG2, `globals`.
 */
export interface OcrEncodedImage {
  readonly _tag: "Encoded";
  readonly codec: OcrCodec;
  readonly data: Uint8Array;
  /** Width in pixels, from the image dictionary. */
  readonly width: number;
  /** Height in pixels, from the image dictionary. */
  readonly height: number;
  /**
   * The codec's numeric and boolean `/DecodeParms` (for CCITT: `K`,
   * `Columns`, `Rows`, `BlackIs1`, `EncodedByteAlign`, …); empty if none.
   */
  readonly parameters: Readonly<Record<string, number | boolean>>;
  /** The decoded `/JBIG2Globals` stream a `jbig2` image shares with others, if it has one. */
  readonly globals: Option.Option<Uint8Array>;
}

/**
 * An image as decoded samples: rows top to bottom, each padded to a whole
 * byte, `components` samples per pixel of `bitsPerComponent` bits.
 */
export interface OcrSampledImage {
  readonly _tag: "Samples";
  readonly data: Uint8Array;
  /** Width in pixels. */
  readonly width: number;
  /** Height in pixels. */
  readonly height: number;
  /** Samples per pixel: 1 (gray), 3 (RGB) or 4 (CMYK). */
  readonly components: 1 | 3 | 4;
  /** Bits per sample: 1, 2, 4, 8 or 16. */
  readonly bitsPerComponent: number;
  /**
   * Whether this is a stencil mask (`/ImageMask`): one bit per pixel, where 0
   * marks the painted pixels unless the image's `/Decode` is `[1 0]`.
   */
  readonly mask: boolean;
}

/** An image for an {@link OcrEngine}, either still encoded or as samples. */
export type OcrImage = OcrEncodedImage | OcrSampledImage;

/**
 * A recognised word and its bounding box, in the image's pixels with the
 * origin at the top-left (the convention OCR engines report in).
 */
export interface OcrWord {
  readonly text: string;
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

/**
 * An OCR engine: recognises the words in an image, in reading order. An
 * image it cannot handle (an unsupported codec, say) may succeed with no
 * words rather than fail; a failure fails the whole read with a
 * `ParseError` whose `cause` is the {@link OcrError}.
 */
export interface OcrEngineShape {
  readonly recognize: (image: OcrImage) => Effect.Effect<ReadonlyArray<OcrWord>, OcrError>;
}

/**
 * The Context tag for the OCR engine the PDF reader uses on scanned pages;
 * `PdfOcrReaderLive` builds a PDF reader from it.
 */
export const OcrEngine = Context.Service<OcrEngineShape>("@thomasfosterau/effect-pdf/OcrEngine");

/** The codec an image filter (full or abbreviated name) leaves the data in. */
const codecOf = (filter: string): Option.Option<OcrCodec> =>
  Match.value(filter).pipe(
    Match.when(Match.is("DCTDecode", "DCT"), () => Option.some<OcrCodec>("jpeg")),
    Match.when("JPXDecode", () => Option.some<OcrCodec>("jpeg2000")),
    Match.when(Match.is("CCITTFaxDecode", "CCF"), () => Option.some<OcrCodec>("ccitt")),
    Match.when("JBIG2Decode", () => Option.some<OcrCodec>("jbig2")),
    Match.orElse(() => Option.none()),
  );

type Components = OcrSampledImage["components"];

/** Samples per pixel for the device and CIE-based colour spaces; none for the rest. */
const componentsOf = (file: PdfFile, space: PdfObject | undefined): Option.Option<Components> => {
  if (isName(space)) {
    return Match.value(space.name).pipe(
      Match.when(Match.is("DeviceGray", "G", "CalGray"), () => Option.some<Components>(1)),
      Match.when(Match.is("DeviceRGB", "RGB", "CalRGB"), () => Option.some<Components>(3)),
      Match.when(Match.is("DeviceCMYK", "CMYK"), () => Option.some<Components>(4)),
      Match.orElse(() => Option.none()),
    );
  }
  if (!isArray(space)) return Option.none();
  const [family, arg] = space.items.map((x) => file.resolve(x));
  if (!isName(family)) return Option.none();
  if (family.name !== "ICCBased" || !isStream(arg)) return componentsOf(file, family);
  const n = file.lookupNumber(arg.dict, "N");
  return n === 1 || n === 3 || n === 4 ? Option.some(n) : Option.none();
};

/** An image dictionary entry under its full or its inline-image (abbreviated) key. */
const entry = (
  file: PdfFile,
  dict: PdfDict,
  key: string,
  short: string,
): Option.Option<PdfObject> =>
  Option.orElse(Option.fromNullishOr(file.lookup(dict, key)), () =>
    Option.fromNullishOr(file.lookup(dict, short)),
  );

const parametersOf = (parms: PdfDict | undefined) =>
  Rec.fromEntries(
    Arr.filter(
      Arr.fromIterable(parms?.entries ?? []),
      (pair): pair is [string, number | boolean] =>
        Predicate.isNumber(pair[1]) || Predicate.isBoolean(pair[1]),
    ),
  );

/** The decoded `/JBIG2Globals` stream named in a JBIG2 image's parameters. */
const globalsOf = (file: PdfFile, parms: PdfDict | undefined): Option.Option<Uint8Array> => {
  const globals = file.lookup(parms, "JBIG2Globals");
  if (!isStream(globals)) return Option.none();
  return Result.getSuccess(Result.try(() => file.decode(globals).data));
};

const SAMPLE_BITS = new Set([1, 2, 4, 8, 16]);

/** Decoded image data as samples, if its colour space and depth are ones an engine can take. */
const sampled = (
  file: PdfFile,
  dict: PdfDict,
  data: Uint8Array,
  width: number,
  height: number,
): Option.Option<OcrSampledImage> => {
  const mask = Option.contains(entry(file, dict, "ImageMask", "IM"), true);
  const bpc = Option.filter(entry(file, dict, "BitsPerComponent", "BPC"), Predicate.isNumber);
  const bitsPerComponent = mask ? 1 : Option.getOrElse(bpc, () => 8);
  const components = mask
    ? Option.some<Components>(1)
    : Option.flatMap(entry(file, dict, "ColorSpace", "CS"), (cs) => componentsOf(file, cs));
  return Option.flatMap(components, (n) =>
    // a truncated image would leave an engine reading past the end
    SAMPLE_BITS.has(bitsPerComponent) &&
    data.length >= Math.ceil((width * n * bitsPerComponent) / 8) * height
      ? Option.some<OcrSampledImage>({
          _tag: "Samples",
          data,
          width,
          height,
          components: n,
          bitsPerComponent,
          mask,
        })
      : Option.none(),
  );
};

/** A positive pixel count from an image dictionary entry. */
const dimension = (
  file: PdfFile,
  dict: PdfDict,
  key: string,
  short: string,
): Option.Option<number> =>
  Option.filter(entry(file, dict, key, short), (v): v is number => Predicate.isNumber(v) && v >= 1);

/**
 * A page image as an {@link OcrImage}, or none when it can't be given to an
 * engine: its data does not decode, its size is missing, or its colour space
 * is indexed, separated or otherwise not device gray, RGB or CMYK.
 */
export const toOcrImage = (file: PdfFile, stream: PdfStream): Option.Option<OcrImage> => {
  const { dict } = stream;
  return Option.gen(function* () {
    const width = yield* dimension(file, dict, "Width", "W");
    const height = yield* dimension(file, dict, "Height", "H");
    const decoded = yield* Result.getSuccess(Result.try(() => file.decode(stream)));
    const codec = Option.flatMap(Option.fromNullishOr(decoded.imageFilter), codecOf);
    if (Option.isNone(codec)) return yield* sampled(file, dict, decoded.data, width, height);
    const image: OcrEncodedImage = {
      _tag: "Encoded",
      codec: codec.value,
      data: decoded.data,
      width,
      height,
      parameters: parametersOf(decoded.imageParms),
      globals: codec.value === "jbig2" ? globalsOf(file, decoded.imageParms) : Option.none(),
    };
    return image;
  });
};

interface OcrLine {
  readonly words: OcrWord[];
  top: number;
  bottom: number;
  right: number;
}

/** Whether `word` continues `line`: its middle within the line's height, and not starting well before the line ends. */
const continues = (line: OcrLine, word: OcrWord): boolean => {
  const middle = (word.top + word.bottom) / 2;
  return (
    middle >= line.top &&
    middle <= line.bottom &&
    word.left >= line.right - (line.bottom - line.top)
  );
};

/**
 * Words grouped into lines in the engine's order: a word starts a new line
 * when its middle is outside the current line's height or it starts well
 * before the previous word ends (a new column or a wrapped line). Blank and
 * zero-height words are dropped.
 */
const linesOf = (words: ReadonlyArray<OcrWord>): OcrLine[] =>
  Arr.reduce(
    Arr.filter(words, (w) => w.text.trim() !== "" && w.bottom > w.top),
    Arr.empty<OcrLine>(),
    (lines, word) => {
      const line = lines.at(-1);
      if (line === undefined || !continues(line, word)) {
        lines.push({ words: [word], top: word.top, bottom: word.bottom, right: word.right });
        return lines;
      }
      line.words.push(word);
      line.top = Math.min(line.top, word.top);
      line.bottom = Math.max(line.bottom, word.bottom);
      line.right = Math.max(line.right, word.right);
      return lines;
    },
  );

const byNumber = Order.Number;

/**
 * Recognised words as page glyphs, one per line of text: placed by the
 * image's `matrix` (see {@link PageImage}), with the line's median word
 * height as its font size, so the layout pass treats OCR text like any
 * other.
 */
export const ocrGlyphs = (
  words: ReadonlyArray<OcrWord>,
  matrix: PageImage["matrix"],
  width: number,
  height: number,
): TextGlyph[] => {
  const [a, b, c, d, e, f] = matrix;
  // image pixels (origin top-left) to the page
  const place = (px: number, py: number): readonly [number, number] => {
    const u = px / width;
    const v = 1 - py / height;
    return [a * u + c * v + e, b * u + d * v + f];
  };
  return linesOf(words).map((line) => {
    const left = Math.min(...line.words.map((w) => w.left));
    const heights = Arr.sort(
      line.words.map((w) => w.bottom - w.top),
      byNumber,
    );
    const [x, y] = place(left, line.bottom);
    const [ex, ey] = place(line.right, line.bottom);
    const [tx, ty] = place(left, line.bottom - (heights[Math.floor(heights.length / 2)] ?? 0));
    return {
      text: line.words.map((w) => w.text.trim()).join(" "),
      x,
      y,
      width: Math.hypot(ex - x, ey - y),
      size: Math.hypot(tx - x, ty - y),
      bold: false,
      italic: false,
      monospace: false,
      upright: Math.abs(ey - y) <= Math.abs(ex - x) * 0.05 + 1e-6 && ex >= x,
    };
  });
};
