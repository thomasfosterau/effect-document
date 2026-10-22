/**
 * The RTF profile: a small prose subset - paragraphs and headings with
 * character-level bold / italic / underline / strikeout. RTF (in this subset)
 * has no ids/classes, links, lists, tables or images, so converting a richer
 * document to RTF forces those features to be narrowed away.
 */

import { defineProfile, type FeaturesOf } from "@thomasfosterau/effect-document";

/** The features the RTF profile allows, as a list. */
export const rtfFeatures = [
  "block.para",
  "block.plain",
  "block.header",
  "inline.str",
  "inline.space",
  "inline.softBreak",
  "inline.lineBreak",
  "inline.emph",
  "inline.strong",
  "inline.underline",
  "inline.strikeout",
] as const;

/** The RTF profile. */
export const Rtf = defineProfile("rtf", rtfFeatures);

/** The features the RTF profile allows, as a type: the phantom of its documents. */
export type RtfFeature = FeaturesOf<typeof Rtf>;
