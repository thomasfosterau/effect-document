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
import { type Doc, type FeaturesOf, defineProfile, trustAs } from "../../profile/profile.js";
import { type Block, Para, Str, document } from "../../schema/index.js";
import { contentToBytes, type Content } from "../../io/content.js";
import { ParseError } from "../../io/errors.js";
import { type Format } from "../../io/format.js";
import { makeReaderTag, type Reader } from "../../io/reader.js";
import { decodeAll, openBundle } from "./bundle.js";
import { TSWP_STORAGE_ARCHIVE } from "./registry.js";
import { storageParagraphs } from "./text.js";

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

/** Create a Pages Reader. */
export const makePagesReader = (): Reader<PagesFeature> => {
  const read = (input: Content): Effect.Effect<Doc<PagesFeature>, ParseError> =>
    Effect.try({
      try: () => {
        const bundle = openBundle(contentToBytes(input));
        const blocks: Block[] = [];
        for (const obj of decodeAll(bundle)) {
          for (const msg of obj.messages) {
            if (!TSWP_STORAGE_ARCHIVE.has(msg.type)) continue;
            for (const line of storageParagraphs(msg.payload)) {
              blocks.push(new Para({ content: [new Str({ text: line })] }));
            }
          }
        }
        return trustAs<PagesFeature>(document(blocks));
      },
      catch: (cause) =>
        new ParseError({ format: "pages", reason: `Failed to read pages: ${String(cause)}`, cause }),
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
