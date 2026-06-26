/**
 * The RTF profile: a small prose subset - paragraphs and headings with
 * character-level bold / italic / underline / strikeout. RTF (in this subset)
 * has no ids/classes, links, lists, tables or images, so converting a richer
 * document to RTF forces those features to be narrowed away.
 */

import { defineProfile, type FeaturesOf } from "../../profile/profile.js";

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

export type RtfFeature = FeaturesOf<typeof Rtf>;
