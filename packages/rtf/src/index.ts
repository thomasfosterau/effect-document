/**
 * effect-document: rtf
 *
 * A Rich Text Format reader and writer for a small prose subset: paragraphs
 * and headings with bold / italic / underline / strikeout runs.
 */

import { type Format } from "@thomasfosterau/effect-document";
import { Rtf, type RtfFeature } from "./profile.js";
import { makeRtfReader } from "./reader.js";
import { makeRtfWriter } from "./writer.js";

export * from "./profile.js";
export * from "./reader.js";
export * from "./writer.js";

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
