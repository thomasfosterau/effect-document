/**
 * effect-document: keynote (read-only, experimental)
 *
 * Reads text from Apple Keynote (.key) presentations: each `Slide-*.iwa`
 * component becomes a slide, and its `TSWP.StorageArchive` text is extracted
 * into a text-box of paragraphs. Styling, exact title/body roles and true slide
 * order (vs. component order) are not yet reconstructed.
 */

import { Effect, Layer } from "effect";
import {
  type Block, type Content, contentToBytes, defineProfile, type Doc, document, type FeaturesOf,
  type Format, makeReaderTag, Para, ParseError, type Reader, Slide, SlideShow, Str, TextBox,
  trustAs,
} from "@thomasfosterau/effect-document";
import { componentPaths, decodeComponent, openBundle } from "./bundle.js";
import { TSWP_STORAGE_ARCHIVE } from "./registry.js";
import { storageParagraphs } from "./text.js";

export const keynoteFeatures = [
  "deck.slideShow",
  "shape.textBox",
  "block.para",
  "block.plain",
  "inline.str",
  "inline.space",
  "inline.softBreak",
  "inline.lineBreak",
] as const;

/** The Keynote (read) profile. */
export const Keynote = defineProfile("keynote", keynoteFeatures);
export type KeynoteFeature = FeaturesOf<typeof Keynote>;

const SLIDE_COMPONENT = /\/Slide-\d+\.iwa$/;

/** Create a Keynote Reader. */
export const makeKeynoteReader = (): Reader<KeynoteFeature> => {
  const read = (input: Content): Effect.Effect<Doc<KeynoteFeature>, ParseError> =>
    Effect.try({
      try: () => {
        const bundle = openBundle(contentToBytes(input));
        const slides: Slide[] = [];
        for (const path of componentPaths(bundle, (n) => SLIDE_COMPONENT.test(n))) {
          const blocks: Block[] = [];
          for (const obj of decodeComponent(bundle, path)) {
            for (const msg of obj.messages) {
              if (!TSWP_STORAGE_ARCHIVE.has(msg.type)) continue;
              for (const line of storageParagraphs(msg.payload)) {
                blocks.push(new Para({ content: [new Str({ text: line })] }));
              }
            }
          }
          slides.push(new Slide({ shapes: blocks.length > 0 ? [new TextBox({ content: blocks })] : [] }));
        }
        if (slides.length === 0) slides.push(new Slide({ shapes: [] }));
        return trustAs<KeynoteFeature>(document([new SlideShow({ slides })]));
      },
      catch: (cause) =>
        new ParseError({ format: "keynote", reason: `Failed to read keynote: ${String(cause)}`, cause }),
    });
  return { format: "keynote", profile: Keynote, read };
};

/** The Keynote profile (alias of {@link Keynote}). */
export const profile = Keynote;

/** The Keynote format bundle (read-only) for use with `convert`. */
export const format: Format<KeynoteFeature> = {
  id: "keynote",
  profile: Keynote,
  reader: makeKeynoteReader(),
};

export const KeynoteReaderTag = makeReaderTag<KeynoteFeature>("keynote");
export const KeynoteReaderLive = Layer.succeed(KeynoteReaderTag, makeKeynoteReader());
