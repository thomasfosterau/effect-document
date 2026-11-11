/**
 * Constructors for the nodes `document.ts` has none for (#125), and a
 * text-friendly builder after Pandoc's `Text.Pandoc.Builder`: `textInlines`
 * splits a string into `Str` / `Space` / `SoftBreak` runs, and
 * `normalizeInlines` merges what readers tend to leave split, for stable
 * round trips.
 */

import * as Predicate from "effect/Predicate";
import { type Attributes } from "./attributes.ts";
import {
  type Block,
  BlockQuote,
  Code,
  DefinitionItem,
  DefinitionList,
  Div,
  Figure,
  HorizontalRule,
  Image,
  type Inline,
  LineBlock,
  LineBreak,
  Math,
  type MathType,
  Note,
  Picture,
  Placeholder,
  Quoted,
  type QuoteType,
  RawBlock,
  RawInline,
  SmallCaps,
  SoftBreak,
  Space,
  Span,
  Strikeout,
  Subscript,
  Superscript,
  Underline,
} from "./ast.ts";
import { str } from "./document.ts";

// ============================================================================
// Inline constructors
// ============================================================================

/** An inter-word `Space`. */
export const space = (): Space => new Space({});
/** A `SoftBreak`: a line break in the source that renders as a space. */
export const softBreak = (): SoftBreak => new SoftBreak({});
/** A `LineBreak`: a hard line break. */
export const lineBreak = (): LineBreak => new LineBreak({});
/** An `Underline` around `content`. */
export const underline = (content: ReadonlyArray<Inline>): Underline => new Underline({ content });
/** A `Strikeout` (struck-through text) around `content`. */
export const strikeout = (content: ReadonlyArray<Inline>): Strikeout => new Strikeout({ content });
/** A `Superscript` around `content`. */
export const superscript = (content: ReadonlyArray<Inline>): Superscript =>
  new Superscript({ content });
/** A `Subscript` around `content`. */
export const subscript = (content: ReadonlyArray<Inline>): Subscript => new Subscript({ content });
/** `SmallCaps` around `content`. */
export const smallCaps = (content: ReadonlyArray<Inline>): SmallCaps => new SmallCaps({ content });
/** `Quoted` content, in double quotation marks unless `quoteType` says `"single"`. */
export const quoted = (content: ReadonlyArray<Inline>, quoteType: QuoteType = "double"): Quoted =>
  new Quoted({ quoteType, content });
/** Inline `Code` of verbatim `text`, with optional attributes (a language class, an id). */
export const code = (text: string, attr?: Attributes): Code =>
  attr === undefined ? new Code({ text }) : new Code({ attr, text });
/** TeX `Math`, inline unless `mathType` says `"display"`. */
export const math = (text: string, mathType: MathType = "inline"): Math =>
  new Math({ mathType, text });
/** A `RawInline`: `text` passed through verbatim to writers of `format` (e.g. `"html"`, `"tex"`). */
export const rawInline = (format: string, text: string): RawInline =>
  new RawInline({ format, text });
/** An `Image` of `url`, described by `alt` (inline content; empty by default), with an optional `title`. */
export const image = (url: string, alt: ReadonlyArray<Inline> = [], title?: string): Image =>
  new Image({ alt, target: title === undefined ? { url } : { url, title } });
/** A `Note` (a footnote) holding `content`. */
export const note = (content: ReadonlyArray<Block>): Note => new Note({ content });
/** A `Span`: inline content carrying attributes. */
export const span = (content: ReadonlyArray<Inline>, attr?: Attributes): Span =>
  attr === undefined ? new Span({ content }) : new Span({ attr, content });

// ============================================================================
// Block constructors
// ============================================================================

/** A `BlockQuote` of `content`. */
export const blockQuote = (content: ReadonlyArray<Block>): BlockQuote =>
  new BlockQuote({ content });
/** A `Div`: blocks carrying attributes. */
export const div = (content: ReadonlyArray<Block>, attr?: Attributes): Div =>
  attr === undefined ? new Div({ content }) : new Div({ attr, content });
/** A `Figure` of `content` with a `caption` (blocks; empty by default). */
export const figure = (
  content: ReadonlyArray<Block>,
  caption: ReadonlyArray<Block> = [],
  attr?: Attributes,
): Figure =>
  attr === undefined ? new Figure({ caption, content }) : new Figure({ attr, caption, content });
/** A `DefinitionList` from `[term, definitions]` pairs, each definition a sequence of blocks. */
export const definitionList = (
  items: ReadonlyArray<readonly [ReadonlyArray<Inline>, ReadonlyArray<ReadonlyArray<Block>>]>,
): DefinitionList =>
  new DefinitionList({
    items: items.map(([term, definitions]) => new DefinitionItem({ term, definitions })),
  });
/** A `LineBlock`: lines kept as written (poetry, addresses), each a sequence of inlines. */
export const lineBlock = (lines: ReadonlyArray<ReadonlyArray<Inline>>): LineBlock =>
  new LineBlock({ lines });
/** A `HorizontalRule`: a thematic break. */
export const horizontalRule = (): HorizontalRule => new HorizontalRule({});
/** A `RawBlock`: `text` passed through verbatim to writers of `format`. */
export const rawBlock = (format: string, text: string): RawBlock => new RawBlock({ format, text });

// ============================================================================
// Shape constructors
// ============================================================================

/** A `Picture` shape showing `src` (a URL, or a `resource:` reference), with optional `alt` text. */
export const picture = (src: string, alt?: string): Picture =>
  alt === undefined ? new Picture({ src }) : new Picture({ src, alt });
/** A `Placeholder` shape of `placeholderType` (`"title"`, `"body"`, …) holding `content`, at layout index `idx` if given. */
export const placeholder = (
  placeholderType: string,
  content: ReadonlyArray<Block>,
  idx?: number,
): Placeholder =>
  idx === undefined
    ? new Placeholder({ placeholderType, content })
    : new Placeholder({ placeholderType, idx, content });

// ============================================================================
// Text builder and normalisation
// ============================================================================

/** A run of whitespace holding a line break, a run of other whitespace, or a word. */
const TOKENS = /(\s*\n\s*)|(\s+)|(\S+)/g;

/**
 * `text` as inline content, as Pandoc's `text` builds it: each word a `Str`,
 * each run of whitespace holding a line break a `SoftBreak`, each other run of
 * whitespace a `Space`; whitespace at either end is dropped.
 *
 * ```ts
 * textInlines("hello  world") // [str("hello"), space(), str("world")]
 * ```
 */
export const textInlines = (text: string): ReadonlyArray<Inline> =>
  Array.from(text.trim().matchAll(TOKENS), ([, newline, , word]): Inline =>
    word !== undefined ? str(word) : newline !== undefined ? softBreak() : space(),
  );

/** Whether an inline is a whitespace node (`Space` or `SoftBreak`). */
const isSpacing = (i: Inline): boolean =>
  Predicate.isTagged(i, "Space") || Predicate.isTagged(i, "SoftBreak");

/**
 * `inlines` normalised, as readers should emit them (#125): adjacent `Str`s
 * merged, empty `Str`s dropped, and each run of `Space` / `SoftBreak` collapsed
 * to one (a `SoftBreak` if the run holds one). Shallow: the content of
 * containers (`Emph`, `Link`, …) is left as it is.
 */
export const normalizeInlines = (inlines: ReadonlyArray<Inline>): ReadonlyArray<Inline> =>
  inlines.reduce<Array<Inline>>((out, i) => {
    if (Predicate.isTagged(i, "Str") && i.text === "") return out;
    const last = out.at(-1);
    if (last === undefined) {
      out.push(i);
    } else if (Predicate.isTagged(last, "Str") && Predicate.isTagged(i, "Str")) {
      out[out.length - 1] = str(last.text + i.text);
    } else if (isSpacing(last) && isSpacing(i)) {
      if (Predicate.isTagged(i, "SoftBreak")) out[out.length - 1] = i;
    } else {
      out.push(i);
    }
    return out;
  }, []);
