/**
 * The RTF Reader: RTF text -> a prose document in the RTF profile.
 *
 * An effect-parse lexer splits the source into groups, control words, control
 * symbols, hex escapes and text; a small interpreter then tracks character
 * formatting through groups (`{ }`), turns `\par` into paragraphs and
 * formatted text into runs (Str wrapped in Emph/Strong/Underline/Strikeout),
 * and skips destination groups it doesn't model (font/colour tables,
 * stylesheets, `\*` destinations).
 */

import { Ascii, Parser, Token } from "@thomasfosterau/effect-parse";
import { Effect, Layer, Result } from "effect";
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

// ============================================================================
// Lexer
// ============================================================================

/** An RTF token. Raw line breaks are kept (as `Newline`) only so that a `\u`
 * fallback character can be skipped exactly as a character-level scan would. */
type RtfToken =
  | { readonly _tag: "Open" }
  | { readonly _tag: "Close" }
  | { readonly _tag: "Word"; readonly word: string; readonly param: string }
  | { readonly _tag: "Symbol"; readonly symbol: string }
  | { readonly _tag: "Hex"; readonly char: string }
  | { readonly _tag: "Text"; readonly text: string }
  | { readonly _tag: "Newline"; readonly text: string };

const letters = Token.takeWhile([Token.range("a", "z"), Token.range("A", "Z")], { min: 1 });
const hexByte = Token.takeWhile([Token.range("0", "9"), Token.range("a", "f"), Token.range("A", "F")], 2);

/** `\word` with an optional integer parameter; one trailing space is part of it. */
const controlWord = Parser.map(
  Parser.seq(
    letters,
    Parser.taken(Parser.seq(Parser.opt(Token.literal("-")), Ascii.digit0)),
    Parser.opt(Token.literal(" "))
  ),
  ([word, param]): RtfToken => ({ _tag: "Word", word, param })
);

/** `\'hh`: one byte, by its hex code. */
const hexEscape = Parser.map(
  Parser.preceded(Token.literal("'"), hexByte),
  (hex): RtfToken => ({ _tag: "Hex", char: String.fromCharCode(Number.parseInt(hex, 16)) })
);

/** `\` followed by a single non-letter: `\\`, `\{`, `\~`, `\*`, ... */
const controlSymbol = Parser.map(Token.any, (symbol): RtfToken => ({ _tag: "Symbol", symbol }));

const rtfToken: Parser.Parser<RtfToken | null> = Parser.alt(
  Parser.as(Token.literal("{"), { _tag: "Open" } as RtfToken),
  Parser.as(Token.literal("}"), { _tag: "Close" } as RtfToken),
  Parser.preceded(
    Token.literal("\\"),
    Parser.alt(controlWord, hexEscape, controlSymbol, Parser.as(Parser.eof, null))
  ),
  Parser.map(Token.takeWhile("\r\n", { min: 1 }), (text): RtfToken => ({ _tag: "Newline", text })),
  Parser.map(Token.takeTill("\\{}\r\n", { min: 1 }), (text): RtfToken => ({ _tag: "Text", text }))
);

/** RTF source as a flat token list. Every input lexes; there is no syntax error. */
const rtfTokens = Parser.compile(Parser.repeat(rtfToken));

// ============================================================================
// Interpreter
// ============================================================================

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

  const controlWord = (word: string, param: string): void => {
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
        pushText(String.fromCodePoint(code < 0 ? code + 65536 : code));
        break;
      }
      default:
        if (DESTINATIONS.has(word)) top().skip = true;
        break;
    }
  };

  // the lexer accepts any input, so this never falls back
  const tokens = Result.getOrElse(Parser.parse(rtfTokens, rtf), () => []);
  // after \uN, the next plain character is its ANSI fallback and is skipped
  let skipFallback = false;
  for (const token of tokens) {
    if (token === null) continue;
    const skipping = skipFallback;
    skipFallback = false;
    switch (token._tag) {
      case "Open":
        flushText();
        stack.push(cloneState(top()));
        break;
      case "Close":
        flushText();
        if (stack.length > 1) stack.pop();
        break;
      case "Word":
        controlWord(token.word, token.param);
        skipFallback = token.word === "u";
        break;
      case "Symbol":
        if (token.symbol === "\\" || token.symbol === "{" || token.symbol === "}") pushText(token.symbol);
        else if (token.symbol === "~") pushText("\u00a0"); // non-breaking space
        else if (token.symbol === "*") top().skip = true;
        // other control symbols (\-, \_, ...) are ignored
        break;
      case "Hex":
        pushText(token.char);
        break;
      case "Text":
        pushText(skipping ? token.text.slice(1) : token.text);
        break;
      case "Newline":
        break; // raw line breaks in RTF source are insignificant
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
