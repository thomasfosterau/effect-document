/**
 * The RTF Reader: RTF text -> a prose document in the RTF profile.
 *
 * An effect-parse lexer splits the source into groups, control words, control
 * symbols, hex escapes, `\bin` data and text; a small interpreter then tracks
 * character formatting through groups (`{ }`), turns `\par` into paragraphs
 * and formatted text into runs (Str wrapped in Emph/Strong/Underline/
 * Strikeout), and skips destination groups it doesn't model (font/colour
 * tables, footnotes, field instructions, `\*` destinations). From the
 * stylesheet it reads only which paragraph styles are headings, so `\sN` and
 * `\outlinelevelN` paragraphs become `Header`s.
 *
 * Bytes (`\'hh` escapes, and raw 8-bit bytes in `Bytes` input) are decoded
 * through the code page of the active font's `\fcharset` / `\cpg`, falling
 * back to the document's `\ansicpg`, so double-byte code pages (932, 936, 949,
 * 950) combine lead and trail bytes.
 */

import { Ascii, Parser, Token } from "@thomasfosterau/effect-parse";
import { Effect, Layer, Result } from "effect";
import {
  type Block,
  type Content,
  type Doc,
  document,
  Emph,
  Header,
  type Inline,
  LineBreak,
  makeReaderTag,
  Para,
  ParseError,
  type Reader,
  Str,
  Strikeout,
  Strong,
  trustAs,
  Underline,
} from "@thomasfosterau/effect-document";
import { Rtf, type RtfFeature } from "./profile.ts";

interface Fmt {
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
}

interface State extends Fmt {
  /** Inside a destination whose text isn't part of the body. */
  skip: boolean;
  /** `\v` hidden text and `\deleted` revisions: present, but not shown. */
  hidden: boolean;
  deleted: boolean;
  /** The active font (`\fN`); `undefined` means the default font (`\deffN`). */
  font: number | undefined;
  /** `\ucN`: how many fallback characters follow each `\uN`. */
  uc: number;
  /** Inside the font table, where `\fN` defines a font instead of selecting one. */
  fontTable: boolean;
  /** Inside the stylesheet: the paragraph style (`\sN`) being defined, if any. */
  styleDef: number | undefined;
}

/** A paragraph style, as far as headings need it. */
interface Style {
  name: string;
  outlineLevel: number | undefined;
  bold: boolean;
}

/** A heading level (1-6) from an outline level (0-8; 9 is body text). */
const headingLevel = (outlineLevel: number | undefined): number | undefined =>
  outlineLevel === undefined || outlineLevel < 0 || outlineLevel > 8
    ? undefined
    : Math.min(6, outlineLevel + 1);

const plainFmt: Fmt = { bold: false, italic: false, underline: false, strike: false };

const cloneState = (s: State): State => ({ ...s });
const fmtEq = (a: Fmt, b: Fmt): boolean =>
  a.bold === b.bold &&
  a.italic === b.italic &&
  a.underline === b.underline &&
  a.strike === b.strike;

const wrapRun = (text: string, fmt: Fmt): Inline => {
  // a lone surrogate from an unpaired `\uN` becomes U+FFFD
  let node: Inline = new Str({ text: text.toWellFormed() });
  if (fmt.italic) node = new Emph({ content: [node] });
  if (fmt.bold) node = new Strong({ content: [node] });
  if (fmt.underline) node = new Underline({ content: [node] });
  if (fmt.strike) node = new Strikeout({ content: [node] });
  return node;
};

/** Destinations whose text never belongs in the body, with or without `\*`. */
const DESTINATIONS = new Set([
  // document tables and metadata
  "fonttbl",
  "colortbl",
  "stylesheet",
  "info",
  "revtbl",
  "pgdsctbl",
  "filetbl",
  "listtable",
  "listoverridetable",
  "rsidtbl",
  "generator",
  "xmlnstbl",
  "themedata",
  "colorschememapping",
  "datastore",
  "latentstyles",
  "mmathPr",
  "operator",
  "company",
  // headers, footers and footnotes
  "header",
  "headerl",
  "headerr",
  "headerf",
  "footer",
  "footerl",
  "footerr",
  "footerf",
  "footnote",
  "ftnsep",
  "ftnsepc",
  "ftncn",
  "aftnsep",
  "aftnsepc",
  "aftncn",
  // comments, index and table-of-contents entries
  "annotation",
  "atnid",
  "atnauthor",
  "xe",
  "tc",
  // pictures, objects and shapes
  "pict",
  "object",
  "objdata",
  "nonshppict",
  "shp",
  "shpinst",
  "shprslt",
  // field instructions (the result, `\fldrslt`, is the visible text)
  "fldinst",
  // list numbering text, which is regenerated from the list definition
  "listtext",
  "pntext",
  "pn",
  "pntxta",
  "pntxtb",
]);

/** Control words that stand for a single character. */
const SPECIAL_CHARACTERS: Record<string, string> = {
  lquote: "\u2018",
  rquote: "\u2019",
  ldblquote: "\u201c",
  rdblquote: "\u201d",
  endash: "\u2013",
  emdash: "\u2014",
  bullet: "\u2022",
  enspace: "\u2002",
  emspace: "\u2003",
  qmspace: "\u2005",
  zwj: "\u200d",
  zwnj: "\u200c",
  zwbo: "\u200b",
  zwnbo: "\u2060",
};

// ============================================================================
// Code pages
// ============================================================================

/** `\fcharsetN` -> Windows code page. Charsets 1 (default) and 2 (symbol) use the document's. */
const CHARSET_CODE_PAGES: Record<number, number> = {
  0: 1252,
  77: 10000,
  128: 932,
  129: 949,
  134: 936,
  136: 950,
  161: 1253,
  162: 1254,
  163: 1258,
  177: 1255,
  178: 1256,
  186: 1257,
  204: 1251,
  222: 874,
  238: 1250,
};

/** A Windows code page's WHATWG encoding label, or `undefined` if unsupported. */
const codePageLabel = (cp: number): string | undefined => {
  switch (cp) {
    case 874:
      return "windows-874";
    case 932:
      return "shift_jis";
    case 936:
      return "gbk";
    case 949:
      return "euc-kr";
    case 950:
      return "big5";
    case 10000:
      return "macintosh";
    case 10007:
      return "x-mac-cyrillic";
    case 20866:
      return "koi8-r";
    case 21866:
      return "koi8-u";
    case 54936:
      return "gb18030";
    case 65001:
      return "utf-8";
  }
  if (cp >= 1250 && cp <= 1258) return `windows-${cp}`;
  if (cp >= 28592 && cp <= 28606) return `iso-8859-${cp - 28590}`;
  return undefined;
};

const decoders = new Map<number, TextDecoder>();

/** A decoder for a code page; unsupported ones (437, 850, ...) decode as cp1252. */
const decoderFor = (cp: number): TextDecoder => {
  let decoder = decoders.get(cp);
  if (decoder === undefined) {
    // Bun types the label as a fixed union; any WHATWG label is accepted at runtime
    const label = (codePageLabel(cp) ?? "windows-1252") as ConstructorParameters<
      typeof TextDecoder
    >[0];
    try {
      decoder = new TextDecoder(label);
    } catch {
      decoder = new TextDecoder("windows-1252");
    }
    decoders.set(cp, decoder);
  }
  return decoder;
};

/** Whether `byte` starts a two-byte character in a double-byte code page. */
const isLeadByte = (cp: number, byte: number): boolean => {
  switch (cp) {
    case 932:
      return (byte >= 0x81 && byte <= 0x9f) || (byte >= 0xe0 && byte <= 0xfc);
    case 936:
    case 949:
    case 950:
    case 54936:
      return byte >= 0x81 && byte <= 0xfe;
    default:
      return false;
  }
};

/** Bytes as a string of the same char codes: RTF is 7-bit ASCII, so bytes are not UTF-8. */
const latin1 = (bytes: Uint8Array): string => {
  let out = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return out;
};

// ============================================================================
// Lexer
// ============================================================================

/** An RTF token. Raw line breaks are kept (as `Newline`) only so the
 * interpreter can tell them apart from text; they carry no meaning. */
type RtfToken =
  | { readonly _tag: "Open" }
  | { readonly _tag: "Close" }
  | { readonly _tag: "Word"; readonly word: string; readonly param: string }
  | { readonly _tag: "Symbol"; readonly symbol: string }
  | { readonly _tag: "Hex"; readonly byte: number }
  | { readonly _tag: "Bin" }
  | { readonly _tag: "Text"; readonly text: string }
  | { readonly _tag: "Newline"; readonly text: string };

const letters = Token.takeWhile([Token.range("a", "z"), Token.range("A", "Z")], { min: 1 });
const hexByte = Token.takeWhile(
  [Token.range("0", "9"), Token.range("a", "f"), Token.range("A", "F")],
  2,
);

/** `\word` with an optional integer parameter; one trailing space is part of it.
 * A `-` belongs to the parameter only when a digit follows it. */
const controlWord = Parser.map(
  Parser.seq(
    letters,
    Parser.taken(Parser.opt(Parser.seq(Parser.opt(Token.literal("-")), Ascii.digit1))),
    Parser.opt(Token.literal(" ")),
  ),
  ([word, param]): RtfToken => ({ _tag: "Word", word, param }),
);

/** `\binN` is followed by N raw bytes, which must not be lexed as RTF. */
const controlWordOrBin = Parser.flatMap(controlWord, (token): Parser.Parser<RtfToken> => {
  if (token._tag !== "Word" || token.word !== "bin") return Parser.succeed(token);
  const count = Math.max(0, Number(token.param || "0"));
  return Parser.as(Parser.alt(Token.take(count), Token.rest), { _tag: "Bin" } as RtfToken);
});

/** `\'hh`: one byte, by its hex code. */
const hexEscape = Parser.map(Parser.preceded(Token.literal("'"), hexByte), (hex): RtfToken => ({
  _tag: "Hex",
  byte: Number.parseInt(hex, 16),
}));

/** `\` followed by a single non-letter: `\\`, `\{`, `\~`, `\*`, ... */
const controlSymbol = Parser.map(Token.any, (symbol): RtfToken => ({ _tag: "Symbol", symbol }));

const rtfToken: Parser.Parser<RtfToken | null> = Parser.alt(
  Parser.as(Token.literal("{"), { _tag: "Open" } as RtfToken),
  Parser.as(Token.literal("}"), { _tag: "Close" } as RtfToken),
  Parser.preceded(
    Token.literal("\\"),
    Parser.alt(controlWordOrBin, hexEscape, controlSymbol, Parser.as(Parser.eof, null)),
  ),
  Parser.map(Token.takeWhile("\r\n", { min: 1 }), (text): RtfToken => ({ _tag: "Newline", text })),
  Parser.map(Token.takeTill("\\{}\r\n", { min: 1 }), (text): RtfToken => ({ _tag: "Text", text })),
);

/** RTF source as a flat token list. Every input lexes; there is no syntax error. */
const rtfTokens = Parser.compile(Parser.repeat(rtfToken));

// ============================================================================
// Interpreter
// ============================================================================

const fail = (reason: string): never => {
  throw new ParseError({ format: "rtf", reason });
};

/**
 * Parse RTF source into a sequence of prose blocks. `binary` marks source
 * decoded from bytes, whose 8-bit characters are code-page bytes.
 */
const parseRtf = (rtf: string, binary: boolean): Block[] => {
  const source = rtf.replace(/^\ufeff/, "").trimStart();
  if (!source.startsWith("{\\rtf")) fail("Not an RTF document: expected it to start with {\\rtf");

  const blocks: Block[] = [];
  let para: Inline[] = [];
  let pendingText = "";
  let pendingFmt: Fmt = plainFmt;
  // \cell separators not yet written: they go before the next cell's content
  let pendingCells = 0;

  // code pages: the document's (\ansicpg), and each font's (\fcharset, \cpg)
  let documentCodePage = 1252;
  let defaultFont: number | undefined;
  let fontDef: number | undefined;
  const fontCodePages = new Map<number, { charset?: number; cpg?: number }>();
  // bytes waiting to be decoded together, so double-byte characters combine
  let bytes: number[] = [];

  const stack: State[] = [
    {
      ...plainFmt,
      skip: false,
      hidden: false,
      deleted: false,
      font: undefined,
      uc: 1,
      fontTable: false,
      styleDef: undefined,
    },
  ];
  const top = (): State => stack[stack.length - 1]!;
  const visible = (): boolean => !top().skip && !top().hidden && !top().deleted;

  // paragraph properties, kept until \pard: the style (\sN) and outline level
  const styles = new Map<number, Style>();
  let paraStyle = 0;
  let paraOutline: number | undefined;
  const styleOf = (n: number): Style => {
    let style = styles.get(n);
    if (style === undefined)
      styles.set(n, (style = { name: "", outlineLevel: undefined, bold: false }));
    return style;
  };
  /** The heading level of the current paragraph: its own outline level, else its style's. */
  const paraHeading = (): number | undefined => {
    if (paraOutline !== undefined) return headingLevel(paraOutline);
    const style = styles.get(paraStyle);
    if (style === undefined) return undefined;
    const named = /^heading\s*([1-9])$/i.exec(style.name.replace(/;\s*$/, "").trim());
    return headingLevel(style.outlineLevel ?? (named ? Number(named[1]) - 1 : undefined));
  };

  const codePage = (): number => {
    const font = top().font ?? defaultFont;
    const entry = font === undefined ? undefined : fontCodePages.get(font);
    return entry?.cpg ?? entry?.charset ?? documentCodePage;
  };

  const flushText = (): void => {
    if (pendingText !== "") {
      para.push(wrapRun(pendingText, pendingFmt));
      pendingText = "";
    }
  };
  const flushPara = (): void => {
    flushBytes();
    flushText();
    pendingCells = 0;
    if (para.length > 0) {
      const level = paraHeading();
      blocks.push(
        level === undefined ? new Para({ content: para }) : new Header({ level, content: para }),
      );
      para = [];
    }
  };
  const append = (s: string): void => {
    // a heading style's own bold (repeated inline for readers that ignore styles) isn't Strong
    const styleBold = paraHeading() !== undefined && styles.get(paraStyle)?.bold === true;
    const state = top();
    const fmt: Fmt = {
      bold: state.bold && !styleBold,
      italic: state.italic,
      underline: state.underline,
      strike: state.strike,
    };
    if (pendingText !== "" && !fmtEq(fmt, pendingFmt)) flushText();
    if (pendingText === "") pendingFmt = fmt;
    pendingText += s;
  };
  /** Write the tabs for cells that ended before this content. */
  const emitCells = (): void => {
    if (pendingCells > 0) {
      append("\t".repeat(pendingCells));
      pendingCells = 0;
    }
  };
  const emit = (s: string): void => {
    if (!visible() || s === "") return;
    emitCells();
    append(s);
  };
  const flushBytes = (): void => {
    if (bytes.length === 0) return;
    const decoded = decoderFor(codePage()).decode(Uint8Array.from(bytes));
    bytes = [];
    emit(decoded);
  };
  const pushText = (s: string): void => {
    flushBytes();
    emit(s);
  };
  const pushByte = (byte: number): void => {
    if (visible()) bytes.push(byte);
  };
  /** Whether the buffered bytes end with a lead byte that still needs its trail byte. */
  const awaitingTrailByte = (): boolean => {
    const cp = codePage();
    let i = 0;
    while (i < bytes.length) i += isLeadByte(cp, bytes[i]!) ? 2 : 1;
    return i > bytes.length;
  };

  /** Handle a control word. Returns the number of fallback characters to skip. */
  const controlWord = (word: string, param: string): number => {
    const on = param !== "0";
    const n = param === "" ? undefined : Number(param);
    const state = top();
    if (state.styleDef !== undefined || word === "stylesheet") {
      switch (word) {
        case "stylesheet":
          state.skip = true;
          state.styleDef = 0;
          break;
        case "s":
          state.styleDef = n ?? 0;
          break;
        // character, table and section styles are not paragraph styles
        case "cs":
        case "ts":
        case "ds":
          state.styleDef = -1;
          break;
        case "outlinelevel":
          styleOf(state.styleDef!).outlineLevel = n ?? 0;
          break;
        case "b":
          styleOf(state.styleDef!).bold = on;
          break;
      }
      return 0;
    }
    if (state.fontTable) {
      if (word === "f") fontDef = n;
      else if (
        (word === "fcharset" || word === "cpg") &&
        fontDef !== undefined &&
        n !== undefined
      ) {
        const entry = fontCodePages.get(fontDef) ?? {};
        if (word === "cpg") entry.cpg = n;
        else if (CHARSET_CODE_PAGES[n] !== undefined) entry.charset = CHARSET_CODE_PAGES[n];
        fontCodePages.set(fontDef, entry);
      }
      return 0;
    }
    const special = SPECIAL_CHARACTERS[word];
    if (special !== undefined) {
      pushText(special);
      return 0;
    }
    switch (word) {
      case "par":
        if (!state.skip) flushPara();
        break;
      case "sect":
      case "page":
      case "column":
        // no sections or pages in the profile: a paragraph break at least
        if (!state.skip) flushPara();
        break;
      case "cell":
      case "nestcell":
        // no tables in the profile yet: cells are tab-separated, rows are paragraphs
        if (visible()) {
          flushBytes();
          pendingCells++;
        }
        break;
      case "row":
      case "nestrow":
        if (!state.skip) flushPara();
        break;
      case "pard":
        paraStyle = 0;
        paraOutline = undefined;
        break; // char flags persist
      case "sectd":
        break; // no section properties are modelled
      case "s":
        paraStyle = n ?? 0;
        break;
      case "outlinelevel":
        paraOutline = n ?? 0;
        break;
      case "plain":
        Object.assign(state, plainFmt, { hidden: false, deleted: false, font: undefined });
        break;
      case "line":
        if (visible()) {
          flushBytes();
          emitCells();
          flushText();
          para.push(new LineBreak());
        }
        break;
      case "tab":
        pushText("\t");
        break;
      case "b":
        state.bold = on;
        break;
      case "i":
        state.italic = on;
        break;
      case "ul":
        state.underline = on;
        break;
      case "ulnone":
        state.underline = false;
        break;
      case "strike":
        state.strike = on;
        break;
      case "v":
        state.hidden = on;
        break;
      case "deleted":
        state.deleted = on;
        break;
      case "f":
        state.font = n;
        break;
      case "deff":
        defaultFont = n;
        break;
      case "ansi":
        documentCodePage = 1252;
        break;
      case "mac":
        documentCodePage = 10000;
        break;
      case "pc":
        documentCodePage = 437;
        break;
      case "pca":
        documentCodePage = 850;
        break;
      case "ansicpg":
        if (n !== undefined) documentCodePage = n;
        break;
      case "uc":
        if (n !== undefined && n >= 0) state.uc = n;
        break;
      case "u": {
        // a signed 16-bit UTF-16 code unit: negative values are N + 65536.
        // Surrogate pairs (two `\u`s) combine in the string itself.
        if (n === undefined) break;
        if (!Number.isInteger(n) || n < -32768 || n > 65535)
          fail(`\\u parameter out of range: ${param}`);
        if (n !== 0) pushText(String.fromCharCode(n < 0 ? n + 65536 : n));
        return state.uc;
      }
      case "fonttbl":
        state.skip = true;
        state.fontTable = true;
        break;
      default:
        if (DESTINATIONS.has(word)) state.skip = true;
        break;
    }
    return 0;
  };

  // the lexer accepts any input, so this never falls back
  const tokens = Result.getOrElse(Parser.parse(rtfTokens, source), () => []);
  // after \uN, the next \ucN characters are its ANSI fallback and are skipped;
  // a \'hh escape, control word or control symbol counts as one character
  let fallback = 0;
  for (const token of tokens) {
    if (token === null) continue;
    if (token._tag === "Text") {
      let text = token.text;
      if (fallback > 0) {
        const n = Math.min(fallback, text.length);
        text = text.slice(n);
        fallback -= n;
      }
      if (text === "") continue;
      // a style's name, inside the stylesheet
      const def = top().styleDef;
      if (def !== undefined) {
        styleOf(def).name += text;
        continue;
      }
      // a double-byte character's trail byte may be written literally: `\'83e`
      if (awaitingTrailByte()) {
        pushByte(text.charCodeAt(0));
        text = text.slice(1);
      }
      if (binary) {
        for (const run of text.match(/[\x80-\xff]+|[^\x80-\xff]+/g) ?? []) {
          if (run.charCodeAt(0) >= 0x80)
            for (let i = 0; i < run.length; i++) pushByte(run.charCodeAt(i));
          else pushText(run);
        }
      } else {
        pushText(text);
      }
      continue;
    }
    if (token._tag === "Newline") continue; // raw line breaks in RTF source are insignificant
    if (token._tag === "Open" || token._tag === "Close") {
      fallback = 0; // a group boundary ends a fallback
    } else if (fallback > 0) {
      fallback--;
      continue;
    }
    if (token._tag === "Hex") {
      pushByte(token.byte);
      continue;
    }
    flushBytes();
    switch (token._tag) {
      case "Open":
        flushText();
        stack.push(cloneState(top()));
        break;
      case "Close":
        flushText();
        stack.pop();
        break;
      case "Word":
        fallback = controlWord(token.word, token.param);
        break;
      case "Symbol":
        if (token.symbol === "\\" || token.symbol === "{" || token.symbol === "}")
          pushText(token.symbol);
        else if (token.symbol === "~") pushText("\u00a0"); // non-breaking space
        else if (token.symbol === "-") pushText("\u00ad"); // optional (soft) hyphen
        else if (token.symbol === "_") pushText("\u2011"); // non-breaking hyphen
        else if (token.symbol === "*") top().skip = true;
        // other control symbols (\| formula, \: index subentry, ...) have no text
        break;
      case "Bin":
        break; // binary data (pictures, objects) is never text
    }
    // the outermost group has closed: anything after it is not part of the document
    if (stack.length === 1) break;
  }
  flushPara();
  return blocks;
};

/** Create an RTF Reader. */
export const makeRtfReader = (): Reader<RtfFeature> => {
  const read = (input: Content): Effect.Effect<Doc<RtfFeature>, ParseError> =>
    Effect.try({
      try: () => {
        const blocks =
          input._tag === "Text" ? parseRtf(input.text, false) : parseRtf(latin1(input.bytes), true);
        return trustAs<RtfFeature>(document(blocks));
      },
      catch: (cause) =>
        cause instanceof ParseError
          ? cause
          : new ParseError({
              format: "rtf",
              reason: `Failed to read rtf: ${String(cause)}`,
              cause,
            }),
    });
  return { format: "rtf", profile: Rtf, read };
};

export const RtfReaderTag = makeReaderTag<RtfFeature>("rtf");
export const RtfReaderLive = Layer.succeed(RtfReaderTag, makeRtfReader());
