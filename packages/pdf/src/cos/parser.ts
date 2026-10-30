/**
 * The PDF lexer and object parser (ISO 32000-2 §7.2-7.3), over raw bytes.
 *
 * A PDF file is binary with random access (the cross-reference table points at
 * byte offsets), so this is a hand-written cursor over a `Uint8Array` rather
 * than a grammar: the parser is positioned at an offset, reads one object, and
 * reports where it stopped. It is deliberately lenient in the ways real files
 * need - wrong stream `/Length`s, junk between tokens, unterminated arrays and
 * dictionaries - and throws a positioned `PdfSyntaxError` only when there is
 * no sensible reading.
 *
 * The same lexer tokenizes content streams, where bare keywords are operators
 * (see `parseContentStream`).
 */

import * as Schema from "effect/Schema";
import * as Predicate from "effect/Predicate";
import {
  type PdfDict,
  type PdfObject,
  type PdfStream,
  pdfArray,
  pdfDict,
  pdfName,
  pdfRef,
  pdfStream,
  pdfString,
} from "./objects.ts";

/** A syntax error at a byte offset in the input. */
export class PdfSyntaxError extends Schema.TaggedError<PdfSyntaxError>()("PdfSyntaxError", {
  reason: Schema.String,
  /** The byte offset the error was found at. */
  offset: Schema.Number,
  /**
   * A machine-readable failure class. `"LimitExceeded"`: arrays and
   * dictionaries nest deeper than {@link MAX_OBJECT_NESTING}.
   */
  code: Schema.optional(Schema.Literal("LimitExceeded")),
}) {
  override get message(): string {
    return `${this.reason} (at byte ${this.offset})`;
  }
}

// ============================================================================
// Character classes
// ============================================================================

const WHITESPACE = new Uint8Array(256);
for (const c of [0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]) WHITESPACE[c] = 1;
const DELIMITER = new Uint8Array(256);
for (const c of "()<>[]{}/%") DELIMITER[c.charCodeAt(0)] = 1;

/** Whether a byte is PDF white-space (NUL, tab, LF, FF, CR or space). */
export const isWhitespace = (c: number): boolean => WHITESPACE[c] === 1;
const isRegular = (c: number): boolean => WHITESPACE[c] === 0 && DELIMITER[c] === 0;
const isDigit = (c: number): boolean => c >= 0x30 && c <= 0x39;

const hexValue = (c: number): number =>
  c >= 0x30 && c <= 0x39
    ? c - 0x30
    : c >= 0x41 && c <= 0x46
      ? c - 0x37
      : c >= 0x61 && c <= 0x66
        ? c - 0x57
        : -1;

// ============================================================================
// Lexer
// ============================================================================

/** A bare keyword: `obj`, `stream`, `R`, or a content-stream operator. */
export interface Keyword {
  readonly _tag: "Keyword";
  readonly word: string;
}

/** A lexical token. Scalars, strings and names are already objects. */
export type Token =
  | { readonly kind: "value"; readonly value: PdfObject }
  | { readonly kind: "keyword"; readonly word: string }
  | { readonly kind: "punct"; readonly char: "[" | "]" | "<<" | ">>" | "{" | "}" }
  | { readonly kind: "eof" };

const EOF: Token = { kind: "eof" };
const DICT_OPEN: Token = { kind: "punct", char: "<<" };
const DICT_CLOSE: Token = { kind: "punct", char: ">>" };

/** The byte a one-letter escape (`\n`, `\r`, `\t`, `\b`, `\f`) stands for, if `e` is one. */
const simpleEscape = (e: number): number | undefined => {
  if (e === 0x6e) return 0x0a;
  if (e === 0x72) return 0x0d;
  if (e === 0x74) return 0x09;
  if (e === 0x62) return 0x08;
  return e === 0x66 ? 0x0c : undefined;
};

/** The one-byte punctuation token a byte starts (`[`, `]`, `{`, `}`), if any. */
const bracketAt = (c: number): Token | undefined => {
  if (c === 0x5b) return { kind: "punct", char: "[" };
  if (c === 0x5d) return { kind: "punct", char: "]" };
  if (c === 0x7b) return { kind: "punct", char: "{" };
  return c === 0x7d ? { kind: "punct", char: "}" } : undefined;
};

/** A cursor over PDF bytes. */
export class Lexer {
  pos: number;

  readonly buf: Uint8Array;

  constructor(buf: Uint8Array, pos = 0) {
    this.buf = buf;
    this.pos = pos;
  }

  /** Skip whitespace and comments. */
  skipWhitespace(): void {
    const buf = this.buf;
    while (this.pos < buf.length) {
      const c = buf[this.pos]!;
      if (WHITESPACE[c] === 1) this.pos++;
      else if (c === 0x25) {
        // % comment, to the end of the line
        while (this.pos < buf.length && buf[this.pos] !== 0x0a && buf[this.pos] !== 0x0d)
          this.pos++;
      } else break;
    }
  }

  /** Read the next token. */
  next(): Token {
    this.skipWhitespace();
    const buf = this.buf;
    if (this.pos >= buf.length) return EOF;
    const start = this.pos;
    const c = buf[this.pos]!;
    const bracket = bracketAt(c);
    if (bracket !== undefined) {
      this.pos++;
      return bracket;
    }
    if (c === 0x3c) return this.lessThan();
    if (c === 0x3e) return this.greaterThan();
    if (c === 0x28) return { kind: "value", value: this.literalString() };
    if (c === 0x2f) return { kind: "value", value: this.name() };
    if (c === 0x29) {
      this.pos++; // a stray `)`
      return this.next();
    }
    if (isDigit(c) || c === 0x2b || c === 0x2d || c === 0x2e)
      return { kind: "value", value: this.number() };
    while (this.pos < buf.length && isRegular(buf[this.pos]!)) this.pos++;
    if (this.pos === start) {
      this.pos++;
      return this.next();
    }
    let word = "";
    for (let i = start; i < this.pos; i++) word += String.fromCharCode(buf[i]!);
    return { kind: "keyword", word };
  }

  /** At `<`: a dictionary opener `<<`, else a hex string. */
  private lessThan(): Token {
    if (this.buf[this.pos + 1] === 0x3c) {
      this.pos += 2;
      return DICT_OPEN;
    }
    return { kind: "value", value: this.hexString() };
  }

  /** At `>`: a dictionary closer `>>`, else a stray `>`, which is skipped. */
  private greaterThan(): Token {
    if (this.buf[this.pos + 1] === 0x3e) {
      this.pos += 2;
      return DICT_CLOSE;
    }
    this.pos++;
    return this.next();
  }

  /** A number. Malformed numbers (`--1`, `1.2.3`) read as best they can. */
  private number(): number {
    const buf = this.buf;
    let sign = 1;
    let sawSign = false;
    while (buf[this.pos] === 0x2b || buf[this.pos] === 0x2d) {
      if (!sawSign && buf[this.pos] === 0x2d) sign = -1;
      sawSign = true;
      this.pos++;
    }
    let value = 0;
    let scale = 0;
    let sawDot = false;
    while (this.pos < buf.length) {
      const c = buf[this.pos]!;
      if (isDigit(c)) {
        value = value * 10 + (c - 0x30);
        if (sawDot) scale++;
      } else if (c === 0x2e && !sawDot) sawDot = true;
      else if (c === 0x2e || c === 0x2d) {
        // junk such as `1.2.3` or `5-`: swallow it with the number
      } else break;
      this.pos++;
    }
    return sign * (scale === 0 ? value : value / 10 ** scale);
  }

  /** `/Name`, with `#xx` escapes decoded. */
  private name(): PdfObject {
    const buf = this.buf;
    this.pos++; // '/'
    let name = "";
    while (this.pos < buf.length && isRegular(buf[this.pos]!)) {
      const c = buf[this.pos]!;
      if (c === 0x23) {
        const hi = hexValue(buf[this.pos + 1] ?? 0);
        const lo = hexValue(buf[this.pos + 2] ?? 0);
        if (hi >= 0 && lo >= 0) {
          name += String.fromCharCode(hi * 16 + lo);
          this.pos += 3;
          continue;
        }
      }
      name += String.fromCharCode(c);
      this.pos++;
    }
    return pdfName(name);
  }

  /** `<48656C6C6F>`; whitespace is ignored and an odd final digit is padded with 0. */
  private hexString(): PdfObject {
    const buf = this.buf;
    this.pos++; // '<'
    const out: number[] = [];
    let hi = -1;
    while (this.pos < buf.length) {
      const c = buf[this.pos++]!;
      if (c === 0x3e) break;
      const v = hexValue(c);
      if (v < 0) continue;
      if (hi < 0) hi = v;
      else {
        out.push(hi * 16 + v);
        hi = -1;
      }
    }
    if (hi >= 0) out.push(hi * 16);
    return pdfString(new Uint8Array(out), true);
  }

  /** `(text)`: balanced parentheses, backslash escapes, and EOLs normalized to LF. */
  /** After a `\` in a literal string: decode one escape sequence into `out`. */
  private escape(out: number[]): void {
    const buf = this.buf;
    const e = buf[this.pos++]!;
    const simple = simpleEscape(e);
    if (simple !== undefined) {
      out.push(simple);
      return;
    }
    if (e === 0x0d) {
      // line continuation
      if (buf[this.pos] === 0x0a) this.pos++;
      return;
    }
    if (e === 0x0a) return;
    if (e >= 0x30 && e <= 0x37) {
      // \ddd: up to three octal digits
      let v = e - 0x30;
      for (let i = 0; i < 2; i++) {
        const d = buf[this.pos];
        if (d === undefined || d < 0x30 || d > 0x37) break;
        v = v * 8 + (d - 0x30);
        this.pos++;
      }
      out.push(v & 0xff);
      return;
    }
    out.push(e); // \( \) \\ and unknown escapes: the character itself
  }

  private literalString(): PdfObject {
    const buf = this.buf;
    this.pos++; // '('
    const out: number[] = [];
    let depth = 1;
    while (this.pos < buf.length) {
      let c = buf[this.pos++]!;
      if (c === 0x28) depth++;
      else if (c === 0x29) {
        if (--depth === 0) break;
      } else if (c === 0x0d) {
        if (buf[this.pos] === 0x0a) this.pos++;
        c = 0x0a;
      } else if (c === 0x5c) {
        if (this.pos >= buf.length) break;
        this.escape(out);
        continue;
      }
      out.push(c);
    }
    return pdfString(new Uint8Array(out), false);
  }
}

// ============================================================================
// Parser
// ============================================================================

/** Resolves an indirect `/Length` while reading a stream. */
export type LengthResolver = (length: PdfObject) => number | undefined;

/** A parsed object, or a keyword where an object was expected. */
type Item = PdfObject | Keyword;

/** Whether a parsed item is a bare keyword (`obj`, `R`, an operator) rather than an object. */
export const isKeyword = (x: PdfObject | Keyword | undefined): x is Keyword =>
  Predicate.isTagged(x, "Keyword");

const ENDSTREAM = [0x65, 0x6e, 0x64, 0x73, 0x74, 0x72, 0x65, 0x61, 0x6d]; // "endstream"

/** Find a byte sequence at or after `from`. */
export const indexOf = (buf: Uint8Array, needle: ReadonlyArray<number>, from = 0): number => {
  const first = needle[0]!;
  outer: for (
    let i = buf.indexOf(first, from);
    i >= 0 && i <= buf.length - needle.length;
    i = buf.indexOf(first, i + 1)
  ) {
    for (let j = 1; j < needle.length; j++) if (buf[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
};

/** Find a byte sequence at or before `from`, searching backwards. */
export const lastIndexOf = (
  buf: Uint8Array,
  needle: ReadonlyArray<number>,
  from = buf.length,
): number => {
  for (let i = Math.min(from, buf.length - needle.length); i >= 0; i--) {
    let match = true;
    for (let j = 0; j < needle.length; j++) {
      if (buf[i + j] !== needle[j]) {
        match = false;
        break;
      }
    }
    if (match) return i;
  }
  return -1;
};

/** A string's character codes as a byte array. */
export const ascii = (s: string): number[] => Array.from(s, (c) => c.charCodeAt(0));

/** An indirect object (`num gen obj … endobj`): its number, generation and value. */
export interface IndirectObject {
  readonly num: number;
  readonly gen: number;
  readonly object: PdfObject;
}

/**
 * How deeply arrays and dictionaries may nest in one object. Real PDFs nest a
 * handful of levels; the parser descends recursively, so deeper input fails
 * with a `"LimitExceeded"` {@link PdfSyntaxError} instead of overflowing the
 * call stack.
 */
export const MAX_OBJECT_NESTING = 512;

/** Reads PDF objects from a lexer. */
export class Parser {
  private peeked: Token | undefined;
  /** How many arrays and dictionaries enclose the current position. */
  private depth = 0;

  readonly lexer: Lexer;
  private readonly resolveLength: LengthResolver | undefined;

  constructor(lexer: Lexer, resolveLength?: LengthResolver) {
    this.lexer = lexer;
    this.resolveLength = resolveLength;
  }

  get pos(): number {
    return this.peeked === undefined ? this.lexer.pos : this.peekStart;
  }

  private peekStart = 0;

  private token(): Token {
    if (this.peeked !== undefined) {
      const t = this.peeked;
      this.peeked = undefined;
      return t;
    }
    return this.lexer.next();
  }

  private peek(): Token {
    if (this.peeked === undefined) {
      this.lexer.skipWhitespace();
      this.peekStart = this.lexer.pos;
      this.peeked = this.lexer.next();
    }
    return this.peeked;
  }

  /** Read one object; a bare keyword comes back as a `Keyword`; `undefined` at end of input. */
  item(): Item | undefined {
    const t = this.token();
    if (t.kind === "eof") {
      return undefined;
    } else if (t.kind === "value") {
      if (Predicate.isNumber(t.value) && Number.isInteger(t.value) && t.value >= 0)
        return this.maybeRef(t.value);
      return t.value;
    } else if (t.kind === "keyword") {
      if (t.word === "true") {
        return true;
      } else if (t.word === "false") {
        return false;
      } else if (t.word === "null") {
        return null;
      }
      return { _tag: "Keyword", word: t.word };
    } else if (t.kind === "punct") {
      if (t.char === "[" || t.char === "<<") {
        return this.container(t.char);
      } else {
        return { _tag: "Keyword", word: t.char };
      }
    }
    return undefined;
  }

  /** An array or a dictionary (or stream), one level deeper, after its opening token. */
  private container(open: "[" | "<<"): PdfObject {
    if (this.depth >= MAX_OBJECT_NESTING)
      throw new PdfSyntaxError({
        reason: `arrays and dictionaries nest more than ${MAX_OBJECT_NESTING} levels deep`,
        offset: this.lexer.pos,
        code: "LimitExceeded",
      });
    this.depth++;
    const object = open === "[" ? this.array() : this.dictOrStream();
    this.depth--;
    return object;
  }

  /** Read one object, treating a keyword where an object belongs as an error. */
  object(): PdfObject {
    const start = this.pos;
    const x = this.item();
    if (x === undefined)
      throw new PdfSyntaxError({ reason: "unexpected end of input", offset: start });
    if (isKeyword(x))
      throw new PdfSyntaxError({ reason: `unexpected keyword "${x.word}"`, offset: start });
    return x;
  }

  /** `12 0 R` after reading `12`, or just the number. */
  private maybeRef(num: number): PdfObject {
    const saved = this.lexer.pos;
    const peeked = this.peeked;
    const gen = this.peek();
    if (
      gen.kind === "value" &&
      Predicate.isNumber(gen.value) &&
      Number.isInteger(gen.value) &&
      gen.value >= 0
    ) {
      this.peeked = undefined;
      const r = this.peek();
      if (r.kind === "keyword" && r.word === "R") {
        this.peeked = undefined;
        return pdfRef(num, gen.value);
      }
    }
    this.lexer.pos = saved;
    this.peeked = peeked;
    return num;
  }

  private array(): PdfObject {
    const items: PdfObject[] = [];
    for (;;) {
      const t = this.peek();
      if (t.kind === "eof") break;
      if (t.kind === "punct" && t.char === "]") {
        this.peeked = undefined;
        break;
      }
      if (t.kind === "punct" && t.char === ">>") break; // unterminated: let the dictionary close
      if (
        t.kind === "keyword" &&
        t.word !== "true" &&
        t.word !== "false" &&
        t.word !== "null" &&
        t.word !== "R"
      )
        break;
      const x = this.item();
      if (x === undefined || isKeyword(x)) continue;
      items.push(x);
    }
    return pdfArray(items);
  }

  private dictOrStream(): PdfObject {
    const entries = new Map<string, PdfObject>();
    for (;;) {
      const t = this.peek();
      if (t.kind === "eof") break;
      if (t.kind === "punct" && t.char === ">>") {
        this.peeked = undefined;
        break;
      }
      if (t.kind === "keyword" && (t.word === "endobj" || t.word === "stream" || t.word === "obj"))
        break;
      this.peeked = undefined;
      if (t.kind !== "value" || !Predicate.isTagged(t.value, "Name")) continue;
      const key = t.value.name;
      const v = this.peek();
      if (v.kind === "punct" && v.char === ">>") {
        entries.set(key, null); // a key with no value
        continue;
      }
      if (v.kind === "keyword" && (v.word === "endobj" || v.word === "stream")) break;
      const value = this.item();
      if (value !== undefined && !isKeyword(value)) entries.set(key, value);
    }
    const dict = pdfDict(entries);
    const next = this.peek();
    if (next.kind === "keyword" && next.word === "stream") {
      this.peeked = undefined;
      return this.streamBody(dict);
    }
    return dict;
  }

  /** The data after a `stream` keyword, up to `endstream`. */
  private streamBody(dict: PdfDict): PdfStream {
    const buf = this.lexer.buf;
    let start = this.lexer.pos;
    // the keyword is followed by CRLF or LF (a lone CR is tolerated)
    if (buf[start] === 0x0d) start++;
    if (buf[start] === 0x0a) start++;

    const declared = dict.entries.get("Length");
    let length = Predicate.isNumber(declared)
      ? declared
      : declared === undefined
        ? undefined
        : this.resolveLength?.(declared);
    if (
      length !== undefined &&
      (length < 0 || !Number.isFinite(length) || !this.endstreamAt(start + length))
    )
      length = undefined;

    let end: number;
    if (length !== undefined) end = start + length;
    else {
      // scan for `endstream` and trim the EOL in front of it
      const at = indexOf(buf, ENDSTREAM, start);
      end = at < 0 ? buf.length : at;
      if (at >= 0) {
        if (buf[end - 1] === 0x0a) end--;
        if (buf[end - 1] === 0x0d) end--;
      }
      end = Math.max(start, end);
    }
    const data = buf.subarray(start, end);
    this.lexer.pos = end;
    const after = this.peek();
    if (after.kind === "keyword" && after.word === "endstream") this.peeked = undefined;
    return pdfStream(dict, data);
  }

  private endstreamAt(pos: number): boolean {
    const buf = this.lexer.buf;
    if (pos > buf.length) return false;
    let p = pos;
    while (p < buf.length && isWhitespace(buf[p]!)) p++;
    for (let j = 0; j < ENDSTREAM.length; j++) if (buf[p + j] !== ENDSTREAM[j]) return false;
    return true;
  }

  /** `n g obj <object> endobj` at the current position. */
  indirect(): IndirectObject {
    const start = this.pos;
    const num = this.token();
    const gen = this.token();
    const kw = this.token();
    if (
      num.kind !== "value" ||
      !Predicate.isNumber(num.value) ||
      gen.kind !== "value" ||
      !Predicate.isNumber(gen.value) ||
      kw.kind !== "keyword" ||
      kw.word !== "obj"
    ) {
      throw new PdfSyntaxError({
        reason: "expected an indirect object header (n g obj)",
        offset: start,
      });
    }
    const item = this.item();
    const object = item === undefined || isKeyword(item) ? null : item;
    const end = this.peek();
    if (end.kind === "keyword" && end.word === "endobj") this.peeked = undefined;
    return { num: num.value, gen: gen.value, object };
  }
}

/** Parse a single object from bytes (e.g. `<< /Type /Page >>`). */
export const parseObject = (bytes: Uint8Array, offset = 0): PdfObject =>
  new Parser(new Lexer(bytes, offset)).object();

// ============================================================================
// Content streams
// ============================================================================

/** One content-stream operation: an operator and its operands. */
export interface Operation {
  readonly op: string;
  readonly operands: ReadonlyArray<PdfObject>;
}

const EI_END = (buf: Uint8Array, i: number): boolean => i >= buf.length || isWhitespace(buf[i]!);

/**
 * Tokenize a content stream into operations (§7.8.2). Inline images
 * (`BI ... ID <data> EI`) come back as a single `BI` operation whose one
 * operand is a stream of the image dictionary and its raw data.
 */
export const parseContentStream = (bytes: Uint8Array): Operation[] => {
  const lexer = new Lexer(bytes);
  const parser = new Parser(lexer);
  const ops: Operation[] = [];
  let operands: PdfObject[] = [];
  for (;;) {
    const x = parser.item();
    if (x === undefined) break;
    if (!isKeyword(x)) {
      operands.push(x);
      continue;
    }
    if (x.word === "BI") {
      ops.push({ op: "BI", operands: [inlineImage(parser, lexer)] });
      operands = [];
      continue;
    }
    if (x.word === "]" || x.word === ">>" || x.word === "{" || x.word === "}") continue;
    ops.push({ op: x.word, operands });
    operands = [];
  }
  return ops;
};

const inlineImage = (parser: Parser, lexer: Lexer): PdfStream => {
  const entries = new Map<string, PdfObject>();
  for (;;) {
    const key = parser.item();
    if (key === undefined) return pdfStream(pdfDict(entries), new Uint8Array(0));
    if (isKeyword(key)) {
      if (key.word === "ID") break;
      continue;
    }
    if (!Predicate.isTagged(key, "Name")) continue;
    const value = parser.item();
    if (value !== undefined && !isKeyword(value)) entries.set(key.name, value);
  }
  const buf = lexer.buf;
  const start = lexer.pos + 1; // one whitespace byte after ID
  let i = start;
  for (; i < buf.length - 1; i++) {
    if (
      buf[i] === 0x45 &&
      buf[i + 1] === 0x49 &&
      isWhitespace(buf[i - 1] ?? 0x20) &&
      EI_END(buf, i + 2)
    )
      break;
  }
  const end = i >= buf.length - 1 ? buf.length : i;
  lexer.pos = Math.min(buf.length, end + 2);
  return pdfStream(pdfDict(entries), buf.subarray(start, Math.max(start, end - 1)));
};
