/**
 * The PPTX profile: a presentation subset - a `SlideShow` of slides, each
 * holding text-box and placeholder shapes whose content is paragraphs/headings/
 * lists with bold/italic/underline/strike runs.
 *
 * Speaker notes (`deck.notes`), pictures and table shapes are out of this v1
 * subset, so converting a richer deck to PPTX narrows those away. Headers are
 * out of the write profile too (#109): only those in title placeholders read
 * back as headers, so headers elsewhere (written as bold paragraphs) would be
 * lost. The reader's own profile, {@link PptxRead}, adds them.
 */

import { defineProfile, type FeaturesOf } from "@thomasfosterau/effect-document";

export const pptxFeatures = [
  "deck.slideShow",
  "shape.textBox",
  "shape.placeholder",
  "block.para",
  "block.plain",
  "block.bulletList",
  "block.orderedList",
  "inline.str",
  "inline.space",
  "inline.softBreak",
  "inline.lineBreak",
  "inline.emph",
  "inline.strong",
  "inline.underline",
  "inline.strikeout",
] as const;

/** The PPTX (PresentationML) profile. */
export const Pptx = defineProfile("pptx", pptxFeatures);

export type PptxFeature = FeaturesOf<typeof Pptx>;

/** What the PPTX reader produces: the PPTX profile plus title-placeholder headers. */
export const PptxRead = defineProfile("pptx-read", [...pptxFeatures, "block.header"] as const);

export type PptxReadFeature = FeaturesOf<typeof PptxRead>;
