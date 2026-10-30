/**
 * Arbitrary documents restricted to a profile, and the normalisation that
 * compares a document with its round trip. Together they enforce the profile
 * policy (#109): every feature in a format's write profile survives
 * `read(write(doc))`, for arbitrary documents in that profile
 * (`integration/profile-property.test.ts`).
 *
 * The generators draw only from the features a profile allows, so a feature
 * added to a write profile without writer and reader support makes the
 * property fail. Text is drawn from a plain alphabet: hostile strings (escapes,
 * control characters, astral and RTL text) are the string-biasing half of the
 * property-testing work in #132.
 */

import * as Arbitrary from "effect/Arbitrary";
import * as Arr from "effect/Array";
import * as Match from "effect/Match";
import * as Schema from "effect/Schema";
import {
  type Block,
  BlockQuote,
  CellBlank,
  CellBoolean,
  CellDate,
  CellError,
  CellFormula,
  CellNumber,
  CellText,
  Code,
  CodeBlock,
  Div,
  Document,
  Emph,
  type Feature,
  Header,
  HorizontalRule,
  type Inline,
  LineBlock,
  LineBreak,
  Link,
  OrderedList,
  BulletList,
  Para,
  Placeholder,
  Plain,
  type NotWithin,
  type Profile,
  type SheetCell,
  sheetRow,
  Slide,
  SlideShow,
  SmallCaps,
  Span,
  SoftBreak,
  Space,
  Str,
  Strikeout,
  Strong,
  Subscript,
  Superscript,
  Table,
  TableCell,
  TableRow,
  TextBox,
  Underline,
  Worksheet,
  type Shape,
} from "@thomasfosterau/effect-document";

// ============================================================================
// Primitive arbitraries
// ============================================================================

/** An integer in `[minimum, maximum]`. */
const int = (minimum: number, maximum: number): Arbitrary.Arbitrary<number> =>
  Arbitrary.schema(Schema.Int.check(Schema.isBetween({ minimum, maximum })));

/** One of `options`, chosen uniformly. */
const oneOf = <A>(options: ReadonlyArray<Arbitrary.Arbitrary<A>>): Arbitrary.Arbitrary<A> =>
  Arbitrary.flatMap(int(0, options.length - 1), (i) => options[i]!);

/** One of the constant `values`. */
const pick = <A>(values: ReadonlyArray<A>): Arbitrary.Arbitrary<A> =>
  Arbitrary.map(int(0, values.length - 1), (i) => values[i]!);

const LETTERS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";

/** A word: letters only, so it never reads as a number, a boolean or markup. */
const word: Arbitrary.Arbitrary<string> = Arbitrary.map(
  Arbitrary.array(pick(Array.from(LETTERS)), { minLength: 1, maxLength: 7 }),
  (chars) => chars.join(""),
);

/** A word that reads as an ordered-list marker at the start of a line: `a.`, `iv)`. */
const MARKER_LIKE = /^([a-zA-Z]|[ivxlcdm]{1,5})[.)]$/;

/** A word with optional trailing punctuation, as prose has. */
const proseWord = (options: ShapeOptions): Arbitrary.Arbitrary<string> =>
  Arbitrary.map(
    Arbitrary.all([word, pick(["", "", "", ".", ",", "!", "?", ";", ":", "-"])]),
    ([w, p]) =>
      // the punctuation moves off a word that would read as a list marker
      options.markerLikeWords === false && MARKER_LIKE.test(w + p) ? w : w + p,
  );

/** Words joined by single spaces. */
const phrase = (maxWords: number): Arbitrary.Arbitrary<string> =>
  Arbitrary.map(Arbitrary.array(word, { minLength: 1, maxLength: maxWords }), (words) =>
    words.join(" "),
  );

// ============================================================================
// Prose
// ============================================================================

/** Mark features and the node each wraps its content in. */
const MARKS: ReadonlyArray<readonly [Feature, (content: ReadonlyArray<Inline>) => Inline]> = [
  ["inline.emph", (content) => new Emph({ content })],
  ["inline.strong", (content) => new Strong({ content })],
  ["inline.underline", (content) => new Underline({ content })],
  ["inline.strikeout", (content) => new Strikeout({ content })],
  ["inline.superscript", (content) => new Superscript({ content })],
  ["inline.subscript", (content) => new Subscript({ content })],
  ["inline.smallCaps", (content) => new SmallCaps({ content })],
];

/** The separators between inline segments the profile allows. */
const separators = (has: (f: Feature) => boolean): ReadonlyArray<Inline> => [
  ...(has("inline.space") ? [new Space()] : []),
  ...(has("inline.softBreak") ? [new SoftBreak()] : []),
  ...(has("inline.lineBreak") ? [new LineBreak()] : []),
];

/**
 * Inline content: segments (a word, a marked or linked run, inline code)
 * separated by spaces and breaks. It never starts or ends with whitespace, and
 * no container is empty, so equal documents have one normal form.
 */
const inlines = (
  ctx: Ctx,
  depth: number,
  inLink = false,
): Arbitrary.Arbitrary<ReadonlyArray<Inline>> => {
  const { has } = ctx;
  const str = Arbitrary.map(proseWord(ctx.options), (text): Inline => new Str({ text }));
  const nested = (): Arbitrary.Arbitrary<ReadonlyArray<Inline>> => inlines(ctx, depth - 1, inLink);
  const segments: Array<Arbitrary.Arbitrary<Inline>> = [str, str, str];
  if (depth > 0) {
    segments.push(
      ...MARKS.filter(([feature]) => has(feature)).map(([, make]) => Arbitrary.map(nested(), make)),
    );
    // a span with an id, where the profile allows one (a span without one says nothing)
    if (has("inline.span") && has("attr.id.span")) {
      segments.push(
        Arbitrary.map(
          Arbitrary.all([nested(), word]),
          ([content, id]): Inline => new Span({ attr: { id: `s-${id}` }, content }),
        ),
      );
    }
    if (has("inline.link") && !inLink) {
      segments.push(
        Arbitrary.map(
          Arbitrary.all([inlines(ctx, depth - 1, true), word]),
          ([content, path]): Inline =>
            new Link({ content, target: { url: `https://example.com/${path}` } }),
        ),
      );
    }
  }
  if (has("inline.code")) {
    segments.push(Arbitrary.map(phrase(3), (text): Inline => new Code({ text })));
  }
  const seps = separators(has);
  // Without any separator a profile can only hold one segment per run of text.
  const maxSegments = Arr.isReadonlyArrayEmpty(seps) ? 1 : 4;
  return Arbitrary.flatMap(
    Arbitrary.array(oneOf(segments), { minLength: 1, maxLength: maxSegments }),
    (parts) =>
      Arbitrary.map(
        Arbitrary.array(pick(Arr.isReadonlyArrayEmpty(seps) ? [new Space()] : seps), {
          minLength: parts.length,
          maxLength: parts.length,
        }),
        (gaps) => parts.flatMap((part, i) => (i === 0 ? [part] : [gaps[i]!, part])),
      ),
  );
};

/** What the prose generators draw from: the profile's features and the shape options. */
interface Ctx {
  readonly has: (f: Feature) => boolean;
  readonly options: ShapeOptions;
  /** The profile's structural rules: features it keeps out of certain nodes (#197). */
  readonly rules: ReadonlyArray<NotWithin>;
}

/** The context for the contents of a `within` node: without the features a rule keeps out of it. */
const inside = (ctx: Ctx, within: Feature): Ctx => {
  const excluded = new Set(ctx.rules.filter((r) => r.within === within).map((r) => r.feature));
  return { ...ctx, has: (f) => ctx.has(f) && !excluded.has(f) };
};

/** The blocks a quote or div (or, by default, a list item) may hold at `depth`. */
const blocks = (
  ctx: Ctx,
  depth: number,
  maxLength: number,
): Arbitrary.Arbitrary<ReadonlyArray<Block>> =>
  Arbitrary.array(block(ctx, depth), { minLength: 1, maxLength });

/** A list item, of the shape `listItems` asks for. */
const listItem = (ctx: Ctx, depth: number): Arbitrary.Arbitrary<ReadonlyArray<Block>> => {
  const shape = ctx.options.listItems ?? "blocks";
  if (shape === "blocks") return blocks(ctx, depth, 2);
  const { has } = ctx;
  const text = inlines(ctx, 2);
  const leads: Array<Arbitrary.Arbitrary<Block>> = [];
  if (has("block.para")) leads.push(Arbitrary.map(text, (content) => new Para({ content })));
  if (has("block.plain")) leads.push(Arbitrary.map(text, (content) => new Plain({ content })));
  const lists = depth > 0 ? listBlocks(ctx, depth) : [];
  return Arbitrary.map(
    Arbitrary.all([
      oneOf(leads),
      Arr.isReadonlyArrayNonEmpty(lists)
        ? Arbitrary.array(oneOf(lists), { minLength: 0, maxLength: 1 })
        : Arbitrary.Constant<ReadonlyArray<Block>>([]),
    ]),
    ([lead, nested]) => [lead, ...nested],
  );
};

/** The list blocks the profile allows, with items at `depth - 1`. */
const listBlocks = (ctx: Ctx, depth: number): ReadonlyArray<Arbitrary.Arbitrary<Block>> => {
  const items = Arbitrary.array(listItem(ctx, depth - 1), { minLength: 1, maxLength: 3 });
  return [
    ...(ctx.has("block.bulletList")
      ? [Arbitrary.map(items, (i): Block => new BulletList({ items: i }))]
      : []),
    ...(ctx.has("block.orderedList")
      ? [Arbitrary.map(items, (i): Block => new OrderedList({ items: i }))]
      : []),
  ];
};

/** A table of one to three rows of up to three paragraph cells. */
const tableOf = (
  text: () => Arbitrary.Arbitrary<ReadonlyArray<Inline>>,
): Arbitrary.Arbitrary<Block> =>
  Arbitrary.flatMap(int(1, 3), (cols) =>
    Arbitrary.map(
      Arbitrary.array(
        Arbitrary.array(
          Arbitrary.map(text(), (content) => new TableCell({ content: [new Para({ content })] })),
          { minLength: cols, maxLength: cols },
        ),
        { minLength: 1, maxLength: 3 },
      ),
      (rows): Block =>
        new Table({
          colSpecs: [],
          head: [],
          body: rows.map((cells) => new TableRow({ cells })),
          foot: [],
        }),
    ),
  );

/** A prose block of a feature the profile allows. */
const block = (ctx: Ctx, depth: number): Arbitrary.Arbitrary<Block> => {
  const text = (): Arbitrary.Arbitrary<ReadonlyArray<Inline>> => inlines(ctx, 2);
  const nested = (): Arbitrary.Arbitrary<ReadonlyArray<Block>> => blocks(ctx, depth - 1, 2);
  // each block feature and its generator; the containers only above depth 0
  const leaves: ReadonlyArray<readonly [Feature, () => Arbitrary.Arbitrary<Block>]> = [
    ["block.para", () => Arbitrary.map(text(), (content): Block => new Para({ content }))],
    ["block.plain", () => Arbitrary.map(text(), (content): Block => new Plain({ content }))],
    [
      "block.header",
      () =>
        Arbitrary.map(
          Arbitrary.all([int(1, 6), inlines(inside(ctx, "block.header"), 2), int(0, 9)]),
          // an id on some headings, where the profile allows one (#184)
          ([level, content, n]): Block =>
            new Header({
              level,
              content,
              attr: ctx.has("attr.id.header") && n % 2 === 0 ? { id: `h${n}` } : undefined,
            }),
        ),
    ],
    [
      "block.codeBlock",
      () =>
        Arbitrary.map(
          Arbitrary.array(phrase(4), { minLength: 1, maxLength: 3 }),
          (lines): Block => new CodeBlock({ text: lines.join("\n") }),
        ),
    ],
    ["block.horizontalRule", () => Arbitrary.Constant<Block>(new HorizontalRule())],
    [
      "block.lineBlock",
      () =>
        Arbitrary.map(
          Arbitrary.array(text(), { minLength: 1, maxLength: 3 }),
          (lines): Block => new LineBlock({ lines }),
        ),
    ],
    ["block.table", () => tableOf(text)],
  ];
  const containers: ReadonlyArray<readonly [Feature, () => Arbitrary.Arbitrary<Block>]> = [
    [
      "block.blockQuote",
      () => Arbitrary.map(nested(), (content): Block => new BlockQuote({ content })),
    ],
    ["block.div", () => Arbitrary.map(nested(), (content): Block => new Div({ content }))],
  ];
  const allowed = (table: ReadonlyArray<readonly [Feature, () => Arbitrary.Arbitrary<Block>]>) =>
    table.filter(([feature]) => ctx.has(feature)).map(([, make]) => make());
  return oneOf([
    ...allowed(leaves),
    ...(depth > 0 ? [...listBlocks(ctx, depth), ...allowed(containers)] : []),
  ]);
};

// ============================================================================
// Spreadsheets
// ============================================================================

const ERRORS = ["#DIV/0!", "#N/A", "#NAME?", "#NULL!", "#NUM!", "#REF!", "#VALUE!"];

/** A cell of a feature the profile allows (blank only when allowed). */
const cellOf = (feature: Feature): Arbitrary.Arbitrary<SheetCell> | undefined =>
  Match.value(feature).pipe(
    Match.when("cell.text", () =>
      Arbitrary.map(phrase(2), (value): SheetCell => new CellText({ value })),
    ),
    Match.when("cell.number", () =>
      Arbitrary.map(
        Arbitrary.all([int(-100_000, 100_000), pick([1, 1, 2, 4, 100])]),
        ([n, d]): SheetCell => new CellNumber({ value: n / d }),
      ),
    ),
    Match.when("cell.boolean", () =>
      Arbitrary.map(pick([true, false]), (value): SheetCell => new CellBoolean({ value })),
    ),
    Match.when("cell.error", () =>
      Arbitrary.map(pick(ERRORS), (value): SheetCell => new CellError({ value })),
    ),
    Match.when("cell.blank", () => Arbitrary.Constant<SheetCell>(new CellBlank({}))),
    Match.when("cell.formula", () =>
      Arbitrary.map(
        Arbitrary.all([int(0, 99), int(0, 99)]),
        ([a, b]): SheetCell => new CellFormula({ formula: `${a}+${b}`, result: `${a + b}` }),
      ),
    ),
    Match.when("cell.date", () =>
      Arbitrary.map(
        int(0, 20_000),
        (days): SheetCell => new CellDate({ value: new Date(Date.UTC(1990, 0, 1 + days)) }),
      ),
    ),
    Match.orElse(() => undefined),
  );

/** The cell features of a profile, in a fixed order. */
const CELL_FEATURES: ReadonlyArray<Feature> = [
  "cell.text",
  "cell.number",
  "cell.boolean",
  "cell.error",
  "cell.blank",
  "cell.formula",
  "cell.date",
];

/**
 * Structural limits a format's documents keep to, beyond its feature set. A
 * profile is a set of features, so it can't say "a list item holds one
 * paragraph"; each limit a format needs is named where it is used, with the
 * issue that tracks lifting it.
 */
export interface ShapeOptions {
  /**
   * What a list item holds: any blocks (`"blocks"`, the default), or one
   * paragraph followed by any nested lists (`"paragraph"`).
   */
  readonly listItems?: "blocks" | "paragraph" | undefined;
  /**
   * Put body paragraphs around the generated prose, for readers that infer
   * structure from layout relative to the body text (PDF headings).
   */
  readonly bodyContext?: boolean | undefined;
  /**
   * `false`: no word reads as an ordered-list marker (`a.`, `iv)`), which a
   * reader inferring lists from layout takes as one where it starts a line.
   */
  readonly markerLikeWords?: boolean | undefined;
  /**
   * Type each column with a single cell feature (plus blanks), for formats
   * that carry types per column rather than per cell (CSV infers each column's
   * type from all of its values, #88).
   */
  readonly columnTyped?: boolean | undefined;
}

/** A worksheet of a rectangular grid of cells the profile allows. */
const sheetOf = (
  name: string,
  has: (f: Feature) => boolean,
  options: ShapeOptions,
): Arbitrary.Arbitrary<Worksheet> => {
  const kinds = CELL_FEATURES.filter(has);
  const valued = kinds.filter((f) => f !== "cell.blank");
  const cells = kinds.flatMap((f) => {
    const a = cellOf(f);
    return a === undefined ? [] : [a];
  });
  const anyCell = oneOf(cells);
  const columnCell = (feature: Feature): Arbitrary.Arbitrary<SheetCell> => {
    const own = cellOf(feature)!;
    return has("cell.blank") ? oneOf([own, own, own, cellOf("cell.blank")!]) : own;
  };
  return Arbitrary.flatMap(Arbitrary.all([int(1, 4), int(1, 5)]), ([cols, rowCount]) =>
    Arbitrary.flatMap(
      options.columnTyped === true
        ? Arbitrary.array(pick(valued), { minLength: cols, maxLength: cols })
        : Arbitrary.Constant<ReadonlyArray<Feature>>([]),
      (columnKinds) =>
        Arbitrary.map(
          Arbitrary.array(
            Arbitrary.all(
              Arr.makeBy(cols, (c) =>
                options.columnTyped === true ? columnCell(columnKinds[c]!) : anyCell,
              ),
            ),
            { minLength: rowCount, maxLength: rowCount },
          ),
          (rows) =>
            new Worksheet({
              name,
              columns: [],
              rows: rows.map((cellsOfRow, index) => sheetRow(index, cellsOfRow)),
              merges: [],
            }),
        ),
    ),
  );
};

// ============================================================================
// Presentations
// ============================================================================

const PLACEHOLDER_TYPES = ["title", "body", "subTitle", "ctrTitle"];

/** A slide show of text boxes and placeholders holding prose the profile allows. */
const slideShowOf = (ctx: Ctx): Arbitrary.Arbitrary<Block> => {
  const { has } = ctx;
  const content = blocks(ctx, 1, 3);
  const shapes: Array<Arbitrary.Arbitrary<Shape>> = [];
  if (has("shape.textBox")) shapes.push(Arbitrary.map(content, (c) => new TextBox({ content: c })));
  if (has("shape.placeholder")) {
    shapes.push(
      Arbitrary.map(
        Arbitrary.all([pick(PLACEHOLDER_TYPES), content]),
        ([placeholderType, c]) => new Placeholder({ placeholderType, content: c }),
      ),
    );
  }
  return Arbitrary.map(
    Arbitrary.array(
      Arbitrary.map(
        Arbitrary.array(oneOf(shapes), { minLength: 1, maxLength: 3 }),
        (s) => new Slide({ shapes: s }),
      ),
      { minLength: 1, maxLength: 3 },
    ),
    (slides) => new SlideShow({ slides }),
  );
};

// ============================================================================
// Documents
// ============================================================================

/** The kind of document a format holds. */
export type Family = "prose" | "sheet" | "deck";

/**
 * Arbitrary documents of the given family that use only the profile's
 * features. `sheet.multiple` decides whether a workbook has more than one sheet.
 */
export const arbitraryDocument = (
  profile: Profile<any>,
  family: Family,
  options: ShapeOptions = {},
): Arbitrary.Arbitrary<Document> => {
  const has = (f: Feature): boolean => profile.features.has(f);
  const ctx: Ctx = { has, options, rules: profile.notWithin };
  const doc = (blocksOf: ReadonlyArray<Block>) => new Document({ meta: {}, blocks: blocksOf });
  // enough body text to outweigh any generated run of headings or code
  const body = (text: string): ReadonlyArray<Block> =>
    options.bodyContext === true
      ? [
          new Para({
            content: [new Str({ text: Array.from({ length: 60 }, () => text).join(" ") })],
          }),
        ]
      : [];
  return Match.value(family).pipe(
    Match.when("prose", () =>
      Arbitrary.map(blocks(ctx, 2, 5), (generated) =>
        doc([...body("Intro."), ...generated, ...body("Outro.")]),
      ),
    ),
    Match.when("deck", () => Arbitrary.map(slideShowOf(ctx), (show) => doc([show]))),
    Match.when("sheet", () =>
      Arbitrary.flatMap(int(1, has("sheet.multiple") ? 3 : 1), (count) =>
        Arbitrary.map(
          Arbitrary.all(Arr.makeBy(count, (i) => sheetOf(`Sheet${i + 1}`, has, options))),
          doc,
        ),
      ),
    ),
    Match.exhaustive,
  );
};
