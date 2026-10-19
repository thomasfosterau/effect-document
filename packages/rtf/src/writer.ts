/**
 * The RTF Writer: an RTF-profile document -> RTF text.
 *
 * Paragraphs become `\pard ... \par`; headings render as bold, larger
 * paragraphs (RTF in this subset has no semantic headings). Character
 * formatting is emitted with localized groups (`{\b ...}`), which keeps the
 * on/off bookkeeping trivial.
 */

import { Effect, Layer } from "effect";
import {
  type Block, type Content, type Doc, type Inline, makeWriterTag, text, type WriteError,
  type Writer,
} from "@thomasfosterau/effect-document";
import { Rtf, type RtfFeature } from "./profile.js";

/** Escape a string for RTF: backslash/braces and non-ASCII via \uN. */
const escapeRtf = (s: string): string => {
  let out = "";
  for (const ch of s) {
    const code = ch.codePointAt(0)!;
    if (ch === "\\" || ch === "{" || ch === "}") out += "\\" + ch;
    else if (code === 0x0a) out += "\\line ";
    else if (code === 0x09) out += "\\tab ";
    else if (code < 0x80) out += ch;
    else out += `\\u${code > 32767 ? code - 65536 : code}?`;
  }
  return out;
};

const renderInline = (n: Inline): string => {
  switch (n._tag) {
    case "Str": return escapeRtf(n.text);
    case "Space": return " ";
    case "SoftBreak": return " ";
    case "LineBreak": return "\\line ";
    case "Emph": return `{\\i ${n.content.map(renderInline).join("")}}`;
    case "Strong": return `{\\b ${n.content.map(renderInline).join("")}}`;
    case "Underline": return `{\\ul ${n.content.map(renderInline).join("")}}`;
    case "Strikeout": return `{\\strike ${n.content.map(renderInline).join("")}}`;
    // RTF profile excludes the rest; if narrowing ever leaves one, fall back to text.
    default: return "";
  }
};

const renderInlines = (ns: ReadonlyArray<Inline>): string => ns.map(renderInline).join("");

const renderBlock = (b: Block): string => {
  switch (b._tag) {
    case "Para":
    case "Plain":
      return `\\pard ${renderInlines(b.content)}\\par\n`;
    case "Header": {
      // headings as bold, size-scaled paragraphs (RTF half-points: \fsN)
      const size = Math.max(20, 36 - (b.level - 1) * 4);
      return `\\pard\\b\\fs${size} ${renderInlines(b.content)}\\b0\\fs24\\par\n`;
    }
    default:
      return "";
  }
};

/** Create an RTF Writer. */
export const makeRtfWriter = (): Writer<RtfFeature> => {
  const write = (doc: Doc<RtfFeature>): Effect.Effect<Content, WriteError> =>
    Effect.sync(() => {
      const body = doc.blocks.map(renderBlock).join("");
      return text(`{\\rtf1\\ansi\\deff0\\fs24\n${body}}`);
    });
  return { format: "rtf", profile: Rtf, write };
};

export const RtfWriterTag = makeWriterTag<RtfFeature>("rtf");
export const RtfWriterLive = Layer.succeed(RtfWriterTag, makeRtfWriter());
