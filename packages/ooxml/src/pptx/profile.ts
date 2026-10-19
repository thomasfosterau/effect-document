/**
 * The PPTX profile: a presentation subset - a `SlideShow` of slides, each
 * holding text-box and placeholder shapes whose content is paragraphs/headings/
 * lists with bold/italic/underline/strike runs.
 *
 * Speaker notes (`deck.notes`), pictures and table shapes are out of this v1
 * subset, so converting a richer deck to PPTX narrows those away.
 */

import { defineProfile, type FeaturesOf } from "@thomasfosterau/effect-document";

export const pptxFeatures = [
  "deck.slideShow",
  "shape.textBox",
  "shape.placeholder",
  "block.para",
  "block.plain",
  "block.header",
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
