/**
 * effect-document: rtf
 *
 * A Rich Text Format reader and writer for a small prose subset: paragraphs
 * and headings with bold / italic / underline / strikeout runs.
 */

import { type Format } from "@thomasfosterau/effect-document";
import { Rtf, type RtfFeature } from "./profile.ts";
import { makeRtfReader } from "./reader.ts";
import { makeRtfWriter } from "./writer.ts";

export * from "./profile.ts";
export * from "./reader.ts";
export * from "./writer.ts";

/** The RTF profile. */
export const profile = Rtf;

/** The RTF format bundle, for use with `convert`. */
export const format: Format<RtfFeature> = {
  id: "rtf",
  readProfile: Rtf,
  writeProfile: Rtf,
  reader: makeRtfReader(),
  writer: makeRtfWriter(),
};
