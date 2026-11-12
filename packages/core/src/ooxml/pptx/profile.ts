/**
 * The PPTX profile: a presentation subset - a `SlideShow` of slides, each
 * holding text-box and placeholder shapes whose content is paragraphs/headings/
 * lists with bold/italic/underline/strike runs.
 *
 * Speaker notes (`deck.notes`), pictures and table shapes are out of this v1
 * subset, so converting a richer deck to PPTX narrows those away. A heading
 * is a slide's title: the reader takes a title placeholder's paragraphs as
 * level-1 headers, and the writer writes a header there as plain title text,
 * so the profile allows `block.header` only at level 1, only inside a title
 * placeholder and not inside a list (#196, with the structural rules of
 * #126). A header anywhere else narrows to a paragraph, with the rule's reason
 * in the loss report.
 */

import { defineProfile, type FeaturesOf, type ProfileOptions } from "../../index.ts";

/** The features the PPTX profile allows, as a list. */
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

/** The placeholder types whose text is a slide's title, which the reader takes as headers. */
export const TITLE_PLACEHOLDER_TYPES: ReadonlyArray<string> = ["title", "ctrTitle"];

const TITLE_ONLY = "PPTX keeps a heading only as a slide's title, the text of a title placeholder";

const pptxRules: ProfileOptions = {
  onlyWithin: [
    {
      feature: "block.header",
      within: "shape.placeholder",
      where: { field: "placeholderType", oneOf: TITLE_PLACEHOLDER_TYPES },
      reason: TITLE_ONLY,
    },
  ],
  fieldValues: [
    {
      feature: "block.header",
      field: "level",
      oneOf: [1],
      reason: "a slide title has one level, so PPTX keeps level-1 headings only",
    },
  ],
  notWithin: [
    { feature: "block.header", within: "block.bulletList", reason: TITLE_ONLY },
    { feature: "block.header", within: "block.orderedList", reason: TITLE_ONLY },
  ],
};

/** The PPTX (PresentationML) profile: what the writer preserves. */
export const Pptx = defineProfile("pptx", pptxFeatures, pptxRules);

/** The features the PPTX profile allows, as a type: the phantom of its documents. */
export type PptxFeature = FeaturesOf<typeof Pptx>;

/**
 * What the PPTX reader produces: {@link Pptx} plus `deck.layout`, the name
 * of the slide layout a slide uses (`Slide.layout`, #82). The writer writes
 * one blank layout, so it cannot keep the name and `Pptx` lacks the feature:
 * narrowing a read deck to `Pptx` drops it, reported in the loss report.
 */
export const PptxRead = defineProfile(
  "pptx-read",
  [...pptxFeatures, "deck.layout"] as const,
  pptxRules,
);

/** The features of {@link PptxRead}, what the PPTX reader produces, as a type. */
export type PptxReadFeature = FeaturesOf<typeof PptxRead>;
