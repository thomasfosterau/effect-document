/**
 * The PDF Reader: .pdf bytes -> a prose document in the PDF profile.
 *
 * Opens the file (repairing a damaged cross-reference table if need be),
 * extracts each page's positioned text, and infers headings, paragraphs,
 * lists, code blocks and inline styling from the layout (see
 * `text/layout`). The document information dictionary becomes the metadata
 * (`title`, `author`, `subject`, `keywords`, `creator`, `producer`).
 *
 * Encrypted files are refused. A page that paints images but has no text
 * layer (a scan) yields no text unless the reader is given an OCR engine (see
 * `ocr.ts`); the pages still without text are listed in the document's
 * `pagesWithoutText` metadata.
 */

import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  type Content,
  type Doc,
  document,
  limitNestingDepth,
  makeReaderTag,
  type Meta,
  ParseError,
  type Reader,
  trustAs,
} from "@thomasfosterau/effect-document";
import { describeCause } from "./describe.ts";
import { PdfFile } from "./cos/file.ts";
import { PdfSyntaxError } from "./cos/parser.ts";
import { isString, latin1ToBytes } from "./cos/objects.ts";
import { decodeTextString } from "./text/encodings.ts";
import { type PageText, extractPageText } from "./text/extract.ts";
import { layoutBlocks } from "./text/layout.ts";
import { OcrEngine, type OcrEngineShape, ocrGlyphs, toOcrImage } from "./ocr.ts";
import { Pdf, type PdfFeature } from "./profile.ts";

/** PDF bytes from content; text is taken one byte per character (Latin-1). */
export const pdfBytes = (input: Content): Uint8Array =>
  Predicate.isTagged(input, "Bytes") ? input.bytes : latin1ToBytes(input.text);

const META_KEYS = [
  ["Title", "title"],
  ["Author", "author"],
  ["Subject", "subject"],
  ["Keywords", "keywords"],
  ["Creator", "creator"],
  ["Producer", "producer"],
] as const;

/** The document information dictionary as metadata. */
export const readMeta = (file: PdfFile): Meta => {
  const meta: Record<string, unknown> = {};
  const info = file.info;
  for (const [key, name] of META_KEYS) {
    const v = file.lookup(info, key);
    if (!isString(v)) continue;
    const text = decodeTextString(v.bytes).trim();
    if (text !== "") meta[name] = text;
  }
  return meta;
};

/** `"LimitExceeded"` when the parser refused input nested too deeply. */
const limitCode = (cause: unknown) => (cause instanceof PdfSyntaxError ? cause.code : undefined);

/** Open a PDF, failing with a `ParseError` if it can't be read or is encrypted. */
export const openPdf = (input: Content): Effect.Effect<PdfFile, ParseError> =>
  Effect.try({
    try: () => PdfFile.open(pdfBytes(input)),
    catch: (cause) =>
      new ParseError({
        format: "pdf",
        reason: describeCause(cause),
        code: limitCode(cause),
        cause,
      }),
  }).pipe(
    Effect.flatMap((file) =>
      file.encrypted
        ? Effect.fail(new ParseError({ format: "pdf", reason: "encrypted PDFs are not supported" }))
        : Effect.succeed(file),
    ),
  );

/** The positioned text of every page. */
export const readPages = (file: PdfFile): PageText[] =>
  file.pages().map((page) => extractPageText(file, page));

/** Whether a page has any visible text. */
const hasText = (page: PageText): boolean => page.glyphs.some((g) => g.text.trim() !== "");

/**
 * The 1-based numbers of the pages that paint images but have no text: the
 * scanned pages a reader without OCR (or whose engine found nothing) could
 * not read.
 */
export const pagesWithoutText = (pages: ReadonlyArray<PageText>): number[] =>
  pages.flatMap((page, i) =>
    !hasText(page) && Arr.isReadonlyArrayNonEmpty(page.images ?? []) ? [i + 1] : [],
  );

/**
 * A textless page with the words `engine` recognises in its images as its
 * text; a page with text, or without images, is returned as is.
 */
const recognizePage = (
  file: PdfFile,
  engine: OcrEngineShape,
  page: PageText,
  index: number,
): Effect.Effect<PageText, ParseError> => {
  if (hasText(page) || page.images === undefined) return Effect.succeed(page);
  // one image at a time: OCR engines are heavy, and the order is the reading order
  return Effect.forEach(
    page.images,
    (placed) =>
      Option.match(toOcrImage(file, placed.stream), {
        // an image no engine could take (an indexed colour space, say) adds no text
        onNone: () => Effect.succeed([]),
        onSome: (image) =>
          engine.recognize(image).pipe(
            Effect.map((words) => ocrGlyphs(words, placed.matrix, image.width, image.height)),
            Effect.mapError(
              (cause) =>
                new ParseError({
                  format: "pdf",
                  reason: `OCR failed on page ${index + 1}: ${cause.reason}`,
                  cause,
                }),
            ),
          ),
      }),
    { concurrency: 1 },
  ).pipe(Effect.map((glyphs) => ({ ...page, glyphs: glyphs.flat() })));
};

/** Options for the PDF reader: the nesting-depth limit and the OCR engine. */
export interface PdfReaderOptions {
  /**
   * The deepest nesting (e.g. lists inside lists) the reader accepts before
   * failing with a `"LimitExceeded"` ParseError. Defaults to
   * `DEFAULT_MAX_NESTING_DEPTH` (128).
   */
  readonly maxDepth?: number | undefined;
  /**
   * The OCR engine for pages that paint images but have no text layer: each
   * image such a page paints is recognised, in painting order, and the words
   * become the page's text. Pages that have text are never sent. Without
   * one, those pages read as empty. Either way, the pages left without text
   * are listed in the document's `pagesWithoutText` metadata (1-based page
   * numbers), which is absent when there are none.
   */
  readonly ocr?: OcrEngineShape | undefined;
}

/** Create a PDF Reader. */
export const makePdfReader = (options?: PdfReaderOptions): Reader<PdfFeature> => {
  const ocr = options?.ocr;
  const read = (input: Content): Effect.Effect<Doc<PdfFeature>, ParseError> =>
    Effect.gen(function* () {
      const file = yield* openPdf(input);
      const extracted = yield* attempt(() => readPages(file));
      const pages =
        ocr === undefined
          ? extracted
          : yield* Effect.forEach(extracted, (page, i) => recognizePage(file, ocr, page, i), {
              concurrency: 1,
            });
      const meta = Arr.match(pagesWithoutText(pages), {
        onEmpty: () => readMeta(file),
        onNonEmpty: (missing) => ({ ...readMeta(file), pagesWithoutText: missing }),
      });
      const doc = yield* attempt(() => trustAs<PdfFeature>(document(layoutBlocks(pages), meta)));
      return yield* limitNestingDepth("pdf", doc, options?.maxDepth);
    });
  return { format: "pdf", profile: Pdf, read };
};

/** Run a synchronous step of the reader, turning a throw into a `ParseError`. */
const attempt = <A>(f: () => A): Effect.Effect<A, ParseError> =>
  Effect.try({
    try: f,
    catch: (cause) =>
      new ParseError({
        format: "pdf",
        reason: describeCause(cause),
        code: limitCode(cause),
        cause,
      }),
  });

/** The Context tag for the PDF reader, so a program can depend on a PDF reader and have one provided. */
export const PdfReaderTag = makeReaderTag<PdfFeature>("pdf");
/** A Layer providing the default PDF reader for {@link PdfReaderTag}. */
export const PdfReaderLive = Layer.succeed(PdfReaderTag, makePdfReader());
/**
 * A Layer providing a PDF reader for {@link PdfReaderTag} that OCRs scanned
 * pages with the {@link OcrEngine} it requires.
 */
export const PdfOcrReaderLive = Layer.effect(
  PdfReaderTag,
  Effect.map(OcrEngine, (ocr) => makePdfReader({ ocr })),
);
