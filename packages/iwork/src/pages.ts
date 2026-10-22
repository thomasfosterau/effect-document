/**
 * effect-document: pages (read-only, experimental)
 *
 * Reads body text from Apple Pages (.pages) documents by extracting the
 * `TSWP.StorageArchive` text across the document's components into a prose
 * document of paragraphs. Styling, headings, lists and tables are not yet
 * reconstructed, and (unlike Keynote) there are no public Pages fixtures, so
 * this path is unvalidated against real files - treat it as best-effort.
 */

import { Effect, Layer } from "effect";
import {
  type Block, type Content, defineProfile, type Doc, document, type FeaturesOf, type Format,
  makeReaderTag, Para, type ParseError, type Reader, Str, trustAs,
} from "@thomasfosterau/effect-document";
import { eachComponent, type IworkReaderOptions, openInput } from "./read.js";
import { TSWP_STORAGE_ARCHIVE } from "./registry.js";
import { storageParagraphs } from "./text.js";

export type { IworkReaderOptions } from "./read.js";

export const pagesFeatures = [
  "block.para",
  "block.plain",
  "inline.str",
  "inline.space",
  "inline.softBreak",
  "inline.lineBreak",
] as const;

/** The Pages (read) profile. */
export const Pages = defineProfile("pages", pagesFeatures);
export type PagesFeature = FeaturesOf<typeof Pages>;

/** Create a Pages Reader. A component that fails to decode fails the read unless `lenient`. */
export const makePagesReader = (options?: IworkReaderOptions): Reader<PagesFeature> => {
  const read = (input: Content): Effect.Effect<Doc<PagesFeature>, ParseError> =>
    Effect.gen(function* () {
      const bundle = yield* openInput("pages", input, options);
      const decoded = yield* eachComponent("pages", bundle, Object.keys(bundle.components), options, (obj) =>
        obj.messages.flatMap((msg) =>
          TSWP_STORAGE_ARCHIVE.has(msg.type)
            ? storageParagraphs(msg.payload).map((line): Block => new Para({ content: [new Str({ text: line })] }))
            : []
        )
      );
      return trustAs<PagesFeature>(document(decoded.flatMap(({ items }) => items)));
    });
  return { format: "pages", profile: Pages, read };
};

/** The Pages profile (alias of {@link Pages}). */
export const profile = Pages;

/** The Pages format bundle (read-only) for use with `convert`. */
export const format: Format<PagesFeature> = {
  id: "pages",
  profile: Pages,
  reader: makePagesReader(),
};

export const PagesReaderTag = makeReaderTag<PagesFeature>("pages");
export const PagesReaderLive = Layer.succeed(PagesReaderTag, makePagesReader());
