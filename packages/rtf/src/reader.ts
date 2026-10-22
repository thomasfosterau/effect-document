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

import * as Rec from "effect/Record";
import * as Option from "effect/Option";
import * as HashMap from "effect/HashMap";
import * as Predicate from "effect/Predicate";
import * as Arr from "effect/Array";
import { Ascii, Parser, Token } from "@thomasfosterau/effect-parse";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
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
const SPECIAL_CHARACTERS = HashMap.fromIterable<string, string>(
  Rec.toEntries({
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
  }),
);

/** The text of the control symbols that stand for a character. */
const SYMBOL_TEXT = HashMap.make(
  ["\\", "\\"],
  ["{", "{"],
  ["}", "}"],
  ["~", "\u00a0"], // non-breaking space
  ["-", "\u00ad"], // optional (soft) hyphen
  ["_", "\u2011"], // non-breaking hyphen
);

// ============================================================================
// Code pages
// ============================================================================

/** `\fcharsetN` -> Windows code page. Charsets 1 (default) and 2 (symbol) use the document's. */
const CHARSET_CODE_PAGES = HashMap.make(
  [0, 1252],
  [77, 10000],
  [128, 932],
  [129, 949],
  [134, 936],
  [136, 950],
  [161, 1253],
  [162, 1254],
  [163, 1258],
  [177, 1255],
  [178, 1256],
  [186, 1257],
  [204, 1251],
  [222, 874],
  [238, 1250],
);

/** A Windows code page's WHATWG encoding label, or `undefined` if unsupported. */
const codePageLabel = (cp: number): string | undefined => {
  if (cp === 874) {
    return "windows-874";
  } else if (cp === 932) {
    return "shift_jis";
  } else if (cp === 936) {
    return "gbk";
  } else if (cp === 949) {
    return "euc-kr";
  } else if (cp === 950) {
    return "big5";
  } else if (cp === 10000) {
    return "macintosh";
  } else if (cp === 10007) {
    return "x-mac-cyrillic";
  } else if (cp === 20866) {
    return "koi8-r";
  } else if (cp === 21866) {
    return "koi8-u";
  } else if (cp === 54936) {
    return "gb18030";
  } else if (cp === 65001) {
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
    // SAFETY: some TypeScript DOM libs type the label as a fixed union, but
    // any WHATWG encoding label is accepted at runtime (and an unknown one
    // throws, which falls back to cp1252 below)
    const label = (codePageLabel(cp) ?? "windows-1252") as ConstructorParameters<
      typeof TextDecoder
    >[0];
    decoder = Result.getOrElse(
      Result.try(() => new TextDecoder(label)),
      () => new TextDecoder("windows-1252"),
    );
    decoders.set(cp, decoder);
  }
  return decoder;
};

/** Whether `byte` starts a two-byte character in a double-byte code page. */
const isLeadByte = (cp: number, byte: number): boolean => {
  if (cp === 932) {
    return (byte >= 0x81 && byte <= 0x9f) || (byte >= 0xe0 && byte <= 0xfc);
  } else if (cp === 936 || cp === 949 || cp === 950 || cp === 54936) {
    return byte >= 0x81 && byte <= 0xfe;
  } else {
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

const BIN: RtfToken = { _tag: "Bin" };
const OPEN: RtfToken = { _tag: "Open" };
const CLOSE: RtfToken = { _tag: "Close" };

/** `\binN` is followed by N raw bytes, which must not be lexed as RTF. */
const controlWordOrBin = Parser.flatMap(controlWord, (token): Parser.Parser<RtfToken> => {
  if (!Predicate.isTagged(token, "Word") || token.word !== "bin") return Parser.succeed(token);
  const count = Math.max(0, Number(token.param || "0"));
  return Parser.as(Parser.alt(Token.take(count), Token.rest), BIN);
});

/** `\'hh`: one byte, by its hex code. */
const hexEscape = Parser.map(Parser.preceded(Token.literal("'"), hexByte), (hex): RtfToken => ({
  _tag: "Hex",
  byte: Number.parseInt(hex, 16),
}));

/** `\` followed by a single non-letter: `\\`, `\{`, `\~`, `\*`, ... */
const controlSymbol = Parser.map(Token.any, (symbol): RtfToken => ({ _tag: "Symbol", symbol }));

const rtfToken: Parser.Parser<RtfToken | null> = Parser.alt(
  Parser.as(Token.literal("{"), OPEN),
  Parser.as(Token.literal("}"), CLOSE),
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
    if (Arr.isReadonlyArrayNonEmpty(para)) {
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
    if (Arr.isReadonlyArrayEmpty(bytes)) return;
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

  /** A control word inside the stylesheet: style numbers, outline levels and bold. */
  const styleSheetWord = (state: State, word: string, n: number | undefined, on: boolean) => {
    if (word === "stylesheet") {
      state.skip = true;
      state.styleDef = 0;
    } else if (word === "s") state.styleDef = n ?? 0;
    // character, table and section styles are not paragraph styles
    else if (word === "cs" || word === "ts" || word === "ds") state.styleDef = -1;
    else if (word === "outlinelevel") styleOf(state.styleDef!).outlineLevel = n ?? 0;
    else if (word === "b") styleOf(state.styleDef!).bold = on;
  };

  /** A control word inside the font table: each font's number and code page. */
  const fontTableWord = (word: string, n: number | undefined) => {
    if (word === "f") fontDef = n;
    if ((word !== "fcharset" && word !== "cpg") || fontDef === undefined || n === undefined) return;
    const entry = fontCodePages.get(fontDef) ?? {};
    if (word === "cpg") entry.cpg = n;
    else {
      const charset = HashMap.get(CHARSET_CODE_PAGES, n);
      if (Option.isSome(charset)) entry.charset = charset.value;
    }
    fontCodePages.set(fontDef, entry);
  };

  /** `\uN`: a signed 16-bit UTF-16 code unit; returns the fallback characters to skip. */
  const unicodeWord = (state: State, n: number | undefined, param: string): number => {
    // negative values are N + 65536; surrogate pairs (two `\u`s) combine in the string itself
    if (n === undefined) return 0;
    if (!Number.isInteger(n) || n < -32768 || n > 65535)
      fail(`\\u parameter out of range: ${param}`);
    if (n !== 0) pushText(String.fromCharCode(n < 0 ? n + 65536 : n));
    return state.uc;
  };

  type WordHandler = (state: State, n: number | undefined, on: boolean) => void;
  const breakPara: WordHandler = (state) => {
    if (!state.skip) flushPara();
  };
  const cell: WordHandler = () => {
    // no tables in the profile yet: cells are tab-separated, rows are paragraphs
    if (visible()) {
      flushBytes();
      pendingCells++;
    }
  };
  const codePageWord =
    (cp: number): WordHandler =>
    () => {
      documentCodePage = cp;
    };
  /** The body's control words; any other is ignored, or skipped as a destination. */
  const BODY_WORDS = HashMap.fromIterable<string, WordHandler>(
    Rec.toEntries<string, WordHandler>({
      par: breakPara,
      // no sections or pages in the profile: a paragraph break at least
      sect: breakPara,
      page: breakPara,
      column: breakPara,
      row: breakPara,
      nestrow: breakPara,
      cell,
      nestcell: cell,
      pard: () => {
        paraStyle = 0;
        paraOutline = undefined; // char flags persist
      },
      // no section properties are modelled
      sectd: () => {},
      s: (_, n) => {
        paraStyle = n ?? 0;
      },
      outlinelevel: (_, n) => {
        paraOutline = n ?? 0;
      },
      plain: (state) => {
        Object.assign(state, plainFmt, { hidden: false, deleted: false, font: undefined });
      },
      line: () => {
        if (!visible()) return;
        flushBytes();
        emitCells();
        flushText();
        para.push(new LineBreak());
      },
      tab: () => pushText("\t"),
      b: (state, _, on) => {
        state.bold = on;
      },
      i: (state, _, on) => {
        state.italic = on;
      },
      ul: (state, _, on) => {
        state.underline = on;
      },
      ulnone: (state) => {
        state.underline = false;
      },
      strike: (state, _, on) => {
        state.strike = on;
      },
      v: (state, _, on) => {
        state.hidden = on;
      },
      deleted: (state, _, on) => {
        state.deleted = on;
      },
      f: (state, n) => {
        state.font = n;
      },
      deff: (_, n) => {
        defaultFont = n;
      },
      ansi: codePageWord(1252),
      mac: codePageWord(10000),
      pc: codePageWord(437),
      pca: codePageWord(850),
      ansicpg: (_, n) => {
        if (n !== undefined) documentCodePage = n;
      },
      uc: (state, n) => {
        if (n !== undefined && n >= 0) state.uc = n;
      },
      fonttbl: (state) => {
        state.skip = true;
        state.fontTable = true;
      },
    }),
  );

  /** Handle a control word. Returns the number of fallback characters to skip. */
  const controlWord = (word: string, param: string): number => {
    const on = param !== "0";
    const n = param === "" ? undefined : Number(param);
    const state = top();
    if (state.styleDef !== undefined || word === "stylesheet") {
      styleSheetWord(state, word, n, on);
      return 0;
    }
    if (state.fontTable) {
      fontTableWord(word, n);
      return 0;
    }
    const special = HashMap.get(SPECIAL_CHARACTERS, word);
    if (Option.isSome(special)) {
      pushText(special.value);
      return 0;
    }
    if (word === "u") return unicodeWord(state, n, param);
    const handler = HashMap.get(BODY_WORDS, word);
    if (Option.isSome(handler)) handler.value(state, n, on);
    else if (DESTINATIONS.has(word)) state.skip = true;
    return 0;
  };

  /** A run of source text (after any `\uN` fallback is skipped). */
  const textRun = (source: string): void => {
    let text = source;
    // a style's name, inside the stylesheet
    const def = top().styleDef;
    if (def !== undefined) {
      styleOf(def).name += text;
      return;
    }
    // a double-byte character's trail byte may be written literally: `\'83e`
    if (awaitingTrailByte()) {
      pushByte(text.charCodeAt(0));
      text = text.slice(1);
    }
    if (!binary) {
      pushText(text);
      return;
    }
    for (const run of text.match(/[\x80-\xff]+|[^\x80-\xff]+/g) ?? []) {
      if (run.charCodeAt(0) >= 0x80)
        for (let i = 0; i < run.length; i++) pushByte(run.charCodeAt(i));
      else pushText(run);
    }
  };

  // the lexer accepts any input, so this never falls back
  const tokens = Result.getOrElse(Parser.parse(rtfTokens, source), () => []);
  // after \uN, the next \ucN characters are its ANSI fallback and are skipped;
  // a \'hh escape, control word or control symbol counts as one character
  let fallback = 0;

  /** Skip what remains of a `\uN` fallback at the start of a text run. */
  const skipFallback = (text: string): string => {
    const n = Math.min(fallback, text.length);
    fallback -= n;
    return text.slice(n);
  };

  const symbol = (sym: string): void => {
    const text = HashMap.get(SYMBOL_TEXT, sym);
    if (Option.isSome(text)) pushText(text.value);
    else if (sym === "*") top().skip = true;
    // other control symbols (\| formula, \: index subentry, ...) have no text
  };

  /** A token that is not text: a group boundary, escape, control word or symbol. */
  const control = (token: Exclude<RtfToken, { readonly _tag: "Text" | "Newline" }>): void => {
    const group = Predicate.isTagged(token, "Open") || Predicate.isTagged(token, "Close");
    if (group) fallback = 0; // a group boundary ends a fallback
    else if (fallback > 0) {
      fallback--;
      return;
    }
    if (Predicate.isTagged(token, "Hex")) return pushByte(token.byte);
    flushBytes();
    if (group) flushText();
    if (Predicate.isTagged(token, "Open")) stack.push(cloneState(top()));
    else if (Predicate.isTagged(token, "Close")) stack.pop();
    else if (Predicate.isTagged(token, "Word")) fallback = controlWord(token.word, token.param);
    else if (Predicate.isTagged(token, "Symbol")) symbol(token.symbol);
    // a Bin token's binary data (pictures, objects) is never text
  };

  for (const token of tokens) {
    if (token === null) continue;
    if (Predicate.isTagged(token, "Text")) {
      const text = skipFallback(token.text);
      if (text !== "") textRun(text);
    } else if (!Predicate.isTagged(token, "Newline")) {
      // raw line breaks in RTF source are insignificant
      control(token);
      // the outermost group has closed: anything after it is not part of the document
      if (stack.length === 1) break;
    }
  }
  flushPara();
  return blocks;
};

/** Create an RTF Reader. */
export const makeRtfReader = (): Reader<RtfFeature> => {
  const read = (input: Content): Effect.Effect<Doc<RtfFeature>, ParseError> =>
    Effect.try({
      try: () => {
        const blocks = Predicate.isTagged(input, "Text")
          ? parseRtf(input.text, false)
          : parseRtf(latin1(input.bytes), true);
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

/** The Context tag for the RTF reader, so a program can depend on an RTF reader and have one provided. */
export const RtfReaderTag = makeReaderTag<RtfFeature>("rtf");
/** A Layer providing the default RTF reader for {@link RtfReaderTag}. */
export const RtfReaderLive = Layer.succeed(RtfReaderTag, makeRtfReader());
