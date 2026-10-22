/**
 * The PDF Reader: .pdf bytes -> a prose document in the PDF profile.
 *
 * Opens the file (repairing a damaged cross-reference table if need be),
 * extracts each page's positioned text, and infers headings, paragraphs,
 * lists, code blocks and inline styling from the layout (see
 * `text/layout`). The document information dictionary becomes the metadata
 * (`title`, `author`, `subject`, `keywords`, `creator`, `producer`).
 *
 * Encrypted files are refused, and scanned pages without a text layer yield
 * no text (there is no OCR).
 */

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
import { isString, latin1ToBytes } from "./cos/objects.ts";
import { decodeTextString } from "./text/encodings.ts";
import { type PageText, extractPageText } from "./text/extract.ts";
import { layoutBlocks } from "./text/layout.ts";
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

/** Open a PDF, failing with a `ParseError` if it can't be read or is encrypted. */
export const openPdf = (input: Content): Effect.Effect<PdfFile, ParseError> =>
  Effect.try({
    try: () => PdfFile.open(pdfBytes(input)),
    catch: (cause) =>
      new ParseError({
        format: "pdf",
        reason: describeCause(cause),
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

/** Options for the PDF reader: the nesting-depth limit. */
export interface PdfReaderOptions {
  /**
   * The deepest nesting (e.g. lists inside lists) the reader accepts before
   * failing with a `"LimitExceeded"` ParseError. Defaults to
   * `DEFAULT_MAX_NESTING_DEPTH` (1000).
   */
  readonly maxDepth?: number | undefined;
}

/** Create a PDF Reader. */
export const makePdfReader = (options?: PdfReaderOptions): Reader<PdfFeature> => {
  const read = (input: Content): Effect.Effect<Doc<PdfFeature>, ParseError> =>
    Effect.flatMap(openPdf(input), (file) =>
      Effect.try({
        try: () => trustAs<PdfFeature>(document(layoutBlocks(readPages(file)), readMeta(file))),
        catch: (cause) =>
          new ParseError({
            format: "pdf",
            reason: describeCause(cause),
            cause,
          }),
      }),
    ).pipe(Effect.flatMap((doc) => limitNestingDepth("pdf", doc, options?.maxDepth)));
  return { format: "pdf", profile: Pdf, read };
};

/** The Context tag for the PDF reader, so a program can depend on a PDF reader and have one provided. */
export const PdfReaderTag = makeReaderTag<PdfFeature>("pdf");
/** A Layer providing the default PDF reader for {@link PdfReaderTag}. */
export const PdfReaderLive = Layer.succeed(PdfReaderTag, makePdfReader());
