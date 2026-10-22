/**
 * effect-document: pages (read-only, experimental)
 *
 * Reads body text from Apple Pages (.pages) documents by extracting the
 * `TSWP.StorageArchive` text across the document's components into a prose
 * document of paragraphs. Styling, headings, lists and tables are not yet
 * reconstructed, and (unlike Keynote) there are no public Pages fixtures, so
 * this path is unvalidated against real files - treat it as best-effort.
 */

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  type Block,
  type Content,
  defineProfile,
  type Doc,
  document,
  type FeaturesOf,
  type Format,
  makeReaderTag,
  Para,
  type ParseError,
  type Reader,
  Str,
  trustAs,
} from "@thomasfosterau/effect-document";
import { eachComponent, type IworkReaderOptions, openInput } from "./read.ts";
import { TSWP_STORAGE_ARCHIVE } from "./registry.ts";
import { storageParagraphs } from "./text.ts";

export type { IworkReaderOptions } from "./read.ts";

/** The features the Pages profile allows, as a list. */
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
/** The features the Pages profile allows, as a type: the phantom of its documents. */
export type PagesFeature = FeaturesOf<typeof Pages>;

/** Create a Pages Reader. A component that fails to decode fails the read unless `lenient`. */
export const makePagesReader = (options?: IworkReaderOptions): Reader<PagesFeature> => {
  const read = (input: Content): Effect.Effect<Doc<PagesFeature>, ParseError> =>
    Effect.gen(function* () {
      const bundle = yield* openInput("pages", input, options);
      const decoded = yield* eachComponent(
        "pages",
        bundle,
        Object.keys(bundle.components),
        options,
        (obj) =>
          obj.messages.flatMap((msg) =>
            TSWP_STORAGE_ARCHIVE.has(msg.type)
              ? storageParagraphs(msg.payload).map(
                  (line): Block => new Para({ content: [new Str({ text: line })] }),
                )
              : [],
          ),
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
  readProfile: Pages,
  writeProfile: Pages,
  reader: makePagesReader(),
};

/** The Context tag for the Pages reader, so a program can depend on a Pages reader and have one provided. */
export const PagesReaderTag = makeReaderTag<PagesFeature>("pages");
/** A Layer providing the default Pages reader for {@link PagesReaderTag}. */
export const PagesReaderLive = Layer.succeed(PagesReaderTag, makePagesReader());
