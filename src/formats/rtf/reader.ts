/**
 * The RTF Reader: RTF text -> a prose document in the RTF profile.
 *
 * A small control-word state machine: it tracks character formatting through
 * groups (`{ }`), turns `\par` into paragraphs and formatted text into runs
 * (Str wrapped in Emph/Strong/Underline/Strikeout), and skips destination
 * groups it doesn't model (font/colour tables, stylesheets, `\*` destinations).
 */

import { Effect, Layer } from "effect";
import { type Doc, trustAs } from "../../profile/profile.js";
import {
  type Block, type Inline, Emph, LineBreak, Para, Str, Strikeout, Strong, Underline,
} from "../../schema/index.js";
import { document } from "../../schema/index.js";
import { contentToText, type Content } from "../../io/content.js";
import { type ParseError } from "../../io/errors.js";
import { makeReaderTag, type Reader } from "../../io/reader.js";
import { Rtf, type RtfFeature } from "./profile.js";

interface Fmt {
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
}

interface State extends Fmt {
  skip: boolean;
}

const cloneState = (s: State): State => ({ ...s });
const fmtEq = (a: Fmt, b: Fmt): boolean =>
  a.bold === b.bold && a.italic === b.italic && a.underline === b.underline && a.strike === b.strike;

const wrapRun = (text: string, fmt: Fmt): Inline => {
  let node: Inline = new Str({ text });
  if (fmt.italic) node = new Emph({ content: [node] });
  if (fmt.bold) node = new Strong({ content: [node] });
  if (fmt.underline) node = new Underline({ content: [node] });
  if (fmt.strike) node = new Strikeout({ content: [node] });
  return node;
};

const DESTINATIONS = new Set([
  "fonttbl", "colortbl", "stylesheet", "info", "pict", "header", "footer",
  "headerl", "headerr", "footerl", "footerr", "pntext", "listtable", "listoverridetable",
  "themedata", "datastore", "generator", "operator", "company",
]);

/** Parse RTF text into a sequence of prose blocks. */
const parseRtf = (rtf: string): Block[] => {
  const blocks: Block[] = [];
  let para: Inline[] = [];
  let pendingText = "";
  let pendingFmt: Fmt = { bold: false, italic: false, underline: false, strike: false };

  const stack: State[] = [{ bold: false, italic: false, underline: false, strike: false, skip: false }];
  const top = (): State => stack[stack.length - 1]!;

  const flushText = (): void => {
    if (pendingText !== "") {
      para.push(wrapRun(pendingText, pendingFmt));
      pendingText = "";
    }
  };
  const flushPara = (): void => {
    flushText();
    if (para.length > 0) {
      blocks.push(new Para({ content: para }));
      para = [];
    }
  };
  const pushText = (s: string): void => {
    if (top().skip || s === "") return;
    const fmt = top();
    if (pendingText !== "" && !fmtEq(fmt, pendingFmt)) flushText();
    if (pendingText === "") pendingFmt = { bold: fmt.bold, italic: fmt.italic, underline: fmt.underline, strike: fmt.strike };
    pendingText += s;
  };

  let i = 0;
  const n = rtf.length;
  while (i < n) {
    const ch = rtf[i]!;
    if (ch === "{") {
      flushText();
      stack.push(cloneState(top()));
      i += 1;
    } else if (ch === "}") {
      flushText();
      if (stack.length > 1) stack.pop();
      i += 1;
    } else if (ch === "\\") {
      const next = rtf[i + 1];
      if (next === undefined) { i += 1; continue; }
      // Control symbol (single non-alphanumeric char)
      if (!/[a-zA-Z]/.test(next)) {
        if (next === "\\" || next === "{" || next === "}") pushText(next);
        else if (next === "~") pushText(" ");
        else if (next === "'") {
          const hex = rtf.substring(i + 2, i + 4);
          if (/^[0-9a-fA-F]{2}$/.test(hex)) {
            pushText(String.fromCharCode(Number.parseInt(hex, 16)));
            i += 4;
            continue;
          }
        }
        // other control symbols (\-, \_, \*) handled below or ignored
        if (next === "*") {
          top().skip = true;
        }
        i += 2;
        continue;
      }
      // Control word: letters, optional integer parameter
      let j = i + 1;
      while (j < n && /[a-zA-Z]/.test(rtf[j]!)) j += 1;
      const word = rtf.substring(i + 1, j);
      let param = "";
      if (j < n && (rtf[j] === "-" || /[0-9]/.test(rtf[j]!))) {
        let k = j;
        if (rtf[k] === "-") k += 1;
        while (k < n && /[0-9]/.test(rtf[k]!)) k += 1;
        param = rtf.substring(j, k);
        j = k;
      }
      // a single trailing space is part of the control word (consumed)
      if (j < n && rtf[j] === " ") j += 1;
      i = j;

      const on = param !== "0" && param !== "-";
      switch (word) {
        case "par": flushPara(); break;
        case "pard": break; // paragraph defaults: char flags persist
        case "line": flushText(); para.push(new LineBreak()); break;
        case "tab": pushText("\t"); break;
        case "b": top().bold = on; break;
        case "i": top().italic = on; break;
        case "ul": top().underline = on; break;
        case "ulnone": top().underline = false; break;
        case "strike": top().strike = on; break;
        case "u": {
          const code = Number.parseInt(param || "0", 10);
          const cp = code < 0 ? code + 65536 : code;
          pushText(String.fromCodePoint(cp));
          if (i < n && rtf[i] !== "\\" && rtf[i] !== "{" && rtf[i] !== "}") i += 1; // skip fallback char
          break;
        }
        default:
          if (DESTINATIONS.has(word)) top().skip = true;
          break;
      }
    } else if (ch === "\n" || ch === "\r") {
      i += 1; // raw line breaks in RTF source are insignificant
    } else {
      pushText(ch);
      i += 1;
    }
  }
  flushPara();
  return blocks;
};

/** Create an RTF Reader. */
export const makeRtfReader = (): Reader<RtfFeature> => {
  const read = (input: Content): Effect.Effect<Doc<RtfFeature>, ParseError> =>
    Effect.sync(() => trustAs<RtfFeature>(document(parseRtf(contentToText(input)))));
  return { format: "rtf", profile: Rtf, read };
};

export const RtfReaderTag = makeReaderTag<RtfFeature>("rtf");
export const RtfReaderLive = Layer.succeed(RtfReaderTag, makeRtfReader());
