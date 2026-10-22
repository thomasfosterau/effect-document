/**
 * effect-document: keynote (read-only, experimental)
 *
 * Reads text from Apple Keynote (.key) presentations: each `Slide-*.iwa`
 * component becomes a slide, and its `TSWP.StorageArchive` text is extracted
 * into a text-box of paragraphs. Slides follow their component ids in numeric
 * order; the true order (the show's slide tree) needs the object resolver.
 * Styling and exact title/body roles are not yet reconstructed.
 */

import { Effect, Layer } from "effect";
import {
  type Block, type Content, defineProfile, type Doc, document, type FeaturesOf, type Format,
  makeReaderTag, Para, type ParseError, type Reader, Slide, SlideShow, Str, TextBox, trustAs,
} from "@thomasfosterau/effect-document";
import { componentPaths } from "./bundle.ts";
import { eachComponent, type IworkReaderOptions, openInput } from "./read.ts";
import { TSWP_STORAGE_ARCHIVE } from "./registry.ts";
import { storageParagraphs } from "./text.ts";

export type { IworkReaderOptions } from "./read.ts";

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

/** `Index/Slide-NNNN.iwa`, or a suffixed `Slide-NNNN-2.iwa` (a separate component). */
const SLIDE_COMPONENT = /\/Slide-\d+(?:-\d+)?\.iwa$/;

/** A storage's paragraphs, one `Para` each. */
const storageBlocks = (payload: Uint8Array): Block[] =>
  storageParagraphs(payload).map((line) => new Para({ content: [new Str({ text: line })] }));

/** Create a Keynote Reader. A component that fails to decode fails the read unless `lenient`. */
export const makeKeynoteReader = (options?: IworkReaderOptions): Reader<KeynoteFeature> => {
  const read = (input: Content): Effect.Effect<Doc<KeynoteFeature>, ParseError> =>
    Effect.gen(function* () {
      const bundle = yield* openInput("keynote", input, options);
      const paths = componentPaths(bundle, (n) => SLIDE_COMPONENT.test(n));
      const decoded = yield* eachComponent("keynote", bundle, paths, options, (obj) =>
        obj.messages.flatMap((msg) => (TSWP_STORAGE_ARCHIVE.has(msg.type) ? storageBlocks(msg.payload) : []))
      );
      const slides = decoded.map(
        ({ items }) => new Slide({ shapes: items.length > 0 ? [new TextBox({ content: items })] : [] })
      );
      if (slides.length === 0) slides.push(new Slide({ shapes: [] }));
      return trustAs<KeynoteFeature>(document([new SlideShow({ slides })]));
    });
  return { format: "keynote", profile: Keynote, read };
};

/** The Keynote profile (alias of {@link Keynote}). */
export const profile = Keynote;

/** The Keynote format bundle (read-only) for use with `convert`. */
export const format: Format<KeynoteFeature> = {
  id: "keynote",
  readProfile: Keynote,
  writeProfile: Keynote,
  reader: makeKeynoteReader(),
};

export const KeynoteReaderTag = makeReaderTag<KeynoteFeature>("keynote");
export const KeynoteReaderLive = Layer.succeed(KeynoteReaderTag, makeKeynoteReader());
