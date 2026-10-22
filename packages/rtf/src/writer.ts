/**
 * The RTF Writer: an RTF-profile document -> RTF text.
 *
 * The header declares the code page (`\ansicpg1252`), the `\u` fallback length
 * (`\uc1`), a minimal font table, colour table and stylesheet. Paragraphs
 * become `\pard ... \par`; headings use the `heading N` styles (`\sN` with
 * `\outlinelevel`), and repeat the style's bold, larger look inline for
 * readers that ignore styles. Character formatting is emitted with localized
 * groups (`{\b ...}`), which keeps the on/off bookkeeping trivial.
 */

import { Effect, Layer } from "effect";
import { absurd } from "effect/Function";
import {
  type Block, type Content, type Doc, type Inline, makeWriterTag, text, type WriteError,
  type Writer,
} from "@thomasfosterau/effect-document";
import { Rtf, type RtfFeature } from "./profile.ts";

/** Options for the RTF writer. Lengths are in twips (1/1440 inch). */
export interface RtfWriterOptions {
  /** The line ending written after the header and each paragraph. Default `"\n"`. */
  readonly lineEnding?: "\n" | "\r\n" | undefined;
  /** The default (body) font's name. Default `"Helvetica"`. */
  readonly font?: string | undefined;
  /** The default font size, in points. Default 12. */
  readonly fontSize?: number | undefined;
  /** Paper size (`\paperw`, `\paperh`); omitted, the reader's default applies. */
  readonly paperWidth?: number | undefined;
  readonly paperHeight?: number | undefined;
  /** Page margins (`\margl`, `\margr`, `\margt`, `\margb`). */
  readonly marginLeft?: number | undefined;
  readonly marginRight?: number | undefined;
  readonly marginTop?: number | undefined;
  readonly marginBottom?: number | undefined;
}

// The node types the profile allows: `"inline.softBreak"` -> `SoftBreak`. Switches
// over these end in `absurd`, so a feature added to the profile but not to the
// writer is a compile error.
type TagOf<F, Kind extends string> = F extends `${Kind}.${infer Name}` ? Capitalize<Name> : never;
type RtfInline = Extract<Inline, { readonly _tag: TagOf<RtfFeature, "inline"> }>;
type RtfBlock = Extract<Block, { readonly _tag: TagOf<RtfFeature, "block"> }>;

/** `\uN` takes a signed 16-bit UTF-16 code unit. */
const unicodeEscape = (unit: number): string => `\\u${unit > 32767 ? unit - 65536 : unit}?`;

/** Escape a string for RTF: backslash/braces, and control and non-ASCII characters via \uN. */
const escapeRtf = (s: string): string => {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    const code = s.charCodeAt(i);
    if (ch === "\\" || ch === "{" || ch === "}") out += "\\" + ch;
    else if (code === 0x0a) out += "\\line ";
    else if (code === 0x09) out += "\\tab ";
    // other control characters are dropped by readers as raw text, so keep them as \uN;
    // astral characters are written as their two surrogates, one \uN each
    else if (code < 0x20 || code >= 0x7f) out += unicodeEscape(code);
    else out += ch;
  }
  return out;
};

const renderInline = (n: RtfInline): string => {
  switch (n._tag) {
    case "Str": return escapeRtf(n.text);
    case "Space": return " ";
    case "SoftBreak": return " ";
    case "LineBreak": return "\\line ";
    case "Emph": return `{\\i ${renderInlines(n.content)}}`;
    case "Strong": return `{\\b ${renderInlines(n.content)}}`;
    case "Underline": return `{\\ul ${renderInlines(n.content)}}`;
    case "Strikeout": return `{\\strike ${renderInlines(n.content)}}`;
    default: return absurd(n);
  }
};

// a profile-conforming document only contains the profile's node types
const renderInlines = (ns: ReadonlyArray<Inline>): string =>
  (ns as ReadonlyArray<RtfInline>).map(renderInline).join("");

/** A heading's size, in half-points (`\fsN`). */
const headingSize = (level: number): number => Math.max(20, 36 - (level - 1) * 4);

const HEADING_LEVELS = [1, 2, 3, 4, 5, 6] as const;

/** A heading's paragraph style: `\sN` for `heading N`, outline level N - 1, bold and larger. */
const headingStyle = (level: number): string => `\\s${level}\\outlinelevel${level - 1}\\b\\fs${headingSize(level)}`;

const renderBlock = (b: RtfBlock, bodySize: number, eol: string): string => {
  switch (b._tag) {
    case "Para":
    case "Plain":
      return `\\pard ${renderInlines(b.content)}\\par${eol}`;
    case "Header":
      return `\\pard${headingStyle(b.level)} ${renderInlines(b.content)}\\b0\\fs${bodySize}\\par${eol}`;
    default:
      return absurd(b);
  }
};

/** A font name for the font table, where `;` ends the name. */
const fontName = (name: string): string => escapeRtf(name.replaceAll(";", ""));

/** The RTF header: code page, fonts, colours, styles and page setup. */
const renderHeader = (options: RtfWriterOptions, bodySize: number, eol: string): string => {
  const fonts = `{\\fonttbl{\\f0\\fswiss\\fcharset0 ${fontName(options.font ?? "Helvetica")};}`
    + `{\\f1\\fmodern\\fcharset0 Courier New;}}`;
  const styles = `{\\stylesheet{\\s0\\fs${bodySize} Normal;}`
    + HEADING_LEVELS.map((level) => `{${headingStyle(level)}\\sbasedon0\\snext0 heading ${level};}`).join("")
    + "}";
  const page = ([
    ["paperw", options.paperWidth], ["paperh", options.paperHeight],
    ["margl", options.marginLeft], ["margr", options.marginRight],
    ["margt", options.marginTop], ["margb", options.marginBottom],
  ] as const)
    .filter(([, value]) => value !== undefined)
    .map(([word, value]) => `\\${word}${Math.round(value!)}`)
    .join("");
  return `{\\rtf1\\ansi\\ansicpg1252\\deff0\\uc1${eol}${fonts}${eol}{\\colortbl;}${eol}${styles}${eol}`
    + `${page}\\f0\\fs${bodySize}${eol}`;
};

/** Create an RTF Writer. */
export const makeRtfWriter = (options: RtfWriterOptions = {}): Writer<RtfFeature> => {
  const eol = options.lineEnding ?? "\n";
  const bodySize = Math.round((options.fontSize ?? 12) * 2);
  const write = (doc: Doc<RtfFeature>): Effect.Effect<Content, WriteError> =>
    Effect.sync(() => {
      const blocks = doc.blocks as ReadonlyArray<RtfBlock>;
      const body = blocks.map((b) => renderBlock(b, bodySize, eol)).join("");
      return text(`${renderHeader(options, bodySize, eol)}${body}}`);
    });
  return { format: "rtf", profile: Rtf, write };
};

export const RtfWriterTag = makeWriterTag<RtfFeature>("rtf");
export const RtfWriterLive = Layer.succeed(RtfWriterTag, makeRtfWriter());
