/**
 * Transforming documents between profiles.
 *
 * `widen` is free: a document in a subset profile already satisfies any superset
 * profile, so widening is an identity (the types guarantee soundness).
 *
 * `narrow` is lossy: it rewrites a document so it conforms to a target profile,
 * dropping or down-converting whatever the target can't represent, and reports
 * exactly what changed. This is the "some conversions will be required" path -
 * e.g. writing an Excel workbook to CSV.
 */

import * as Rec from "effect/Record";
import * as Match from "effect/Match";
import * as Predicate from "effect/Predicate";
import * as Arr from "effect/Array";
import * as Result from "effect/Result";
import * as Effect from "effect/Effect";
import { type Attributes } from "../schema/attributes.ts";
import {
  type Block,
  BlockQuote,
  BulletList,
  CellBlank,
  CellBoolean,
  CellDate,
  CellError,
  CellFormula,
  CellNumber,
  CellRichText,
  CellText,
  Cite,
  Citation,
  Code,
  Div,
  Emph,
  Figure,
  Header,
  Image,
  type Inline,
  Link,
  Math,
  Note,
  OrderedList,
  Para,
  Picture,
  Placeholder,
  Plain,
  Quoted,
  RawInline,
  type SheetCell,
  type Shape,
  IndexedCell,
  SheetColumn,
  SheetRow,
  Slide,
  SlideShow,
  SmallCaps,
  Span,
  Str,
  Strikeout,
  Strong,
  Subscript,
  Superscript,
  Table,
  TableCell,
  TableRow,
  TableShape,
  TextBox,
  Underline,
  Worksheet,
} from "../schema/ast.ts";
import { Document, blocksToText, cellToText, inlinesToText } from "../schema/document.ts";
import { denseRows, sheetRow } from "../schema/sheet.ts";
import { type Feature } from "../schema/feature.ts";
import { type Doc, type Profile } from "./profile.ts";
import { dispatchTag, type TagHandlers } from "./dispatch.ts";

// ============================================================================
// Loss report
// ============================================================================

/** One thing `narrow` could not keep: the feature, whether it was dropped or converted, and why. */
export interface LossEntry {
  /** The feature that could not be represented. */
  readonly feature: Feature;
  /** What happened: dropped, or down-converted to something simpler. */
  readonly action: "dropped" | "converted";
  /** A short human-readable explanation. */
  readonly detail: string;
}

/** Everything a narrowing (or a conversion) dropped or down-converted. */
export interface LossReport {
  readonly entries: ReadonlyArray<LossEntry>;
  /** True when nothing was lost (the narrowing was a no-op). */
  readonly isLossless: boolean;
}

/** The narrowed document and the loss report for it. */
export interface NarrowResult<To extends Feature> {
  readonly document: Doc<To>;
  readonly loss: LossReport;
}

// ============================================================================
// widen
// ============================================================================

/**
 * Widen a document to a superset profile. Pure identity at runtime; the
 * constraint `From extends To` makes this safe only when `To` is a superset.
 */
export const widen = <To extends Feature, From extends To = To>(doc: Doc<From>): Doc<To> =>
  // SAFETY: `From extends To`, and `Doc`'s feature parameter is a phantom in a
  // covariant position, so every `Doc<From>` is a valid `Doc<To>`.
  doc as Doc<To>;

// ============================================================================
// narrow
// ============================================================================

class Recorder {
  readonly entries: LossEntry[] = [];
  drop(feature: Feature, detail: string): void {
    this.entries.push({ feature, action: "dropped", detail });
  }
  convert(feature: Feature, detail: string): void {
    this.entries.push({ feature, action: "converted", detail });
  }
}

interface Ctx {
  readonly allowed: ReadonlySet<Feature>;
  readonly rec: Recorder;
}

/** One populated attribute facet, kept if the target allows it, else recorded as dropped. */
const keepFacet = <A>(
  value: A | undefined,
  feature: Feature,
  reason: string,
  ctx: Ctx,
): A | undefined => {
  if (value === undefined || ctx.allowed.has(feature)) return value;
  ctx.rec.drop(feature, reason);
  return undefined;
};

const narrowAttr = (attr: Attributes | undefined, ctx: Ctx): Attributes | undefined => {
  if (attr === undefined) return undefined;
  const classes =
    attr.classes !== undefined && Arr.isReadonlyArrayNonEmpty(attr.classes)
      ? attr.classes
      : undefined;
  const data =
    attr.data !== undefined && !Rec.isEmptyReadonlyRecord(attr.data) ? attr.data : undefined;
  // facets in a fixed order, so the loss report lists them id → classes → style → data
  const out: { -readonly [K in keyof Attributes]: Attributes[K] } = {};
  const id = keepFacet(attr.id, "attr.id", "format does not support element ids", ctx);
  if (id !== undefined) out.id = id;
  const keptClasses = keepFacet(classes, "attr.classes", "format does not support classes", ctx);
  if (keptClasses !== undefined) out.classes = keptClasses;
  const style = keepFacet(attr.style, "attr.style", "format does not support inline styling", ctx);
  if (style !== undefined) out.style = style;
  const keptData = keepFacet(
    data,
    "attr.keyValue",
    "format does not support custom attributes",
    ctx,
  );
  if (keptData !== undefined) out.data = keptData;
  const kept = [id, keptClasses, style, keptData].some((facet) => facet !== undefined);
  return kept ? out : undefined;
};

// ---- inlines --------------------------------------------------------------

const narrowInlines = (inlines: ReadonlyArray<Inline>, ctx: Ctx): Inline[] =>
  inlines.flatMap((i) => narrowInline(i, ctx));

/**
 * A formatting wrapper: kept with its narrowed content when the profile has
 * `feature`, else replaced by that content (a `converted` loss).
 */
const wrapper =
  <N extends { readonly content: ReadonlyArray<Inline> }>(
    feature: Feature,
    detail: string,
    rebuild: (n: N, content: Inline[], ctx: Ctx) => Inline,
  ) =>
  (n: N, ctx: Ctx): Inline[] => {
    const inner = narrowInlines(n.content, ctx);
    if (ctx.allowed.has(feature)) return [rebuild(n, inner, ctx)];
    ctx.rec.convert(feature, detail);
    return inner;
  };

/** A text-bearing inline: kept when the profile has `feature`, else its text as a `Str`. */
const textual =
  <N extends { readonly text: string }>(
    feature: Feature,
    detail: string,
    rebuild: (n: N, ctx: Ctx) => Inline,
  ) =>
  (n: N, ctx: Ctx): Inline[] => {
    if (ctx.allowed.has(feature)) return [rebuild(n, ctx)];
    ctx.rec.convert(feature, detail);
    return [new Str({ text: n.text })];
  };

/** Kept as it is: every profile has these. */
const always = (n: Inline): Inline[] => [n];

const INLINE: TagHandlers<Inline, [Ctx], Inline[]> = {
  Str: always,
  Space: always,
  SoftBreak: always,
  LineBreak: always,
  Emph: wrapper("inline.emph", "Emph unwrapped to its text", (_, content) => new Emph({ content })),
  Strong: wrapper(
    "inline.strong",
    "Strong unwrapped to its text",
    (_, content) => new Strong({ content }),
  ),
  Underline: wrapper(
    "inline.underline",
    "Underline unwrapped to its text",
    (_, content) => new Underline({ content }),
  ),
  Strikeout: wrapper(
    "inline.strikeout",
    "Strikeout unwrapped to its text",
    (_, content) => new Strikeout({ content }),
  ),
  Superscript: wrapper(
    "inline.superscript",
    "Superscript unwrapped to its text",
    (_, content) => new Superscript({ content }),
  ),
  Subscript: wrapper(
    "inline.subscript",
    "Subscript unwrapped to its text",
    (_, content) => new Subscript({ content }),
  ),
  SmallCaps: wrapper(
    "inline.smallCaps",
    "SmallCaps unwrapped to its text",
    (_, content) => new SmallCaps({ content }),
  ),
  Quoted: wrapper(
    "inline.quoted",
    "Quoted unwrapped to its text",
    (n, content) => new Quoted({ quoteType: n.quoteType, content }),
  ),
  Span: wrapper(
    "inline.span",
    "Span unwrapped to its content",
    (n, content, ctx) => new Span({ attr: narrowAttr(n.attr, ctx), content }),
  ),
  Link: wrapper(
    "inline.link",
    "Link reduced to its text",
    (n, content, ctx) => new Link({ attr: narrowAttr(n.attr, ctx), content, target: n.target }),
  ),
  Image: (n, ctx) => {
    if (ctx.allowed.has("inline.image"))
      return [
        new Image({
          attr: narrowAttr(n.attr, ctx),
          alt: narrowInlines(n.alt, ctx),
          target: n.target,
        }),
      ];
    ctx.rec.convert("inline.image", "Image reduced to its alt text");
    return narrowInlines(n.alt, ctx);
  },
  Code: textual(
    "inline.code",
    "Code reduced to text",
    (n, ctx) => new Code({ attr: narrowAttr(n.attr, ctx), text: n.text }),
  ),
  Math: textual(
    "inline.math",
    "Math reduced to text",
    (n) => new Math({ mathType: n.mathType, text: n.text }),
  ),
  Cite: (n, ctx) => {
    if (!ctx.allowed.has("inline.cite")) {
      ctx.rec.convert("inline.cite", "Cite reduced to its text");
      return narrowInlines(n.content, ctx);
    }
    const citations = n.citations.map(
      (c) =>
        new Citation({
          id: c.id,
          mode: c.mode,
          prefix: narrowInlines(c.prefix, ctx),
          suffix: narrowInlines(c.suffix, ctx),
        }),
    );
    return [new Cite({ citations, content: narrowInlines(n.content, ctx) })];
  },
  RawInline: (n, ctx) => {
    if (ctx.allowed.has("inline.rawInline"))
      return [new RawInline({ format: n.format, text: n.text })];
    ctx.rec.drop("inline.rawInline", "raw inline content dropped");
    return [];
  },
  Note: (n, ctx) => {
    if (ctx.allowed.has("inline.note"))
      return [new Note({ content: narrowBlocks(n.content, ctx) })];
    ctx.rec.drop("inline.note", "note dropped");
    return [];
  },
};

const narrowInline = (n: Inline, ctx: Ctx): Inline[] => dispatchTag(INLINE, n, ctx);

// ---- spreadsheet ----------------------------------------------------------

type CellStyle = SheetCell["style"];

/** A typed cell: kept when the profile has `feature`, else converted to a text cell. */
const typedCell =
  <C extends SheetCell>(
    feature: Feature,
    detail: string,
    keep: (c: C, style: CellStyle, ctx: Ctx) => SheetCell,
    asText: (c: C, style: CellStyle, ctx: Ctx) => SheetCell,
  ) =>
  (c: C, style: CellStyle, ctx: Ctx): SheetCell => {
    if (ctx.allowed.has(feature)) return keep(c, style, ctx);
    ctx.rec.convert(feature, detail);
    return asText(c, style, ctx);
  };

const cellText = (c: SheetCell, style: CellStyle): SheetCell =>
  new CellText({ value: cellToText(c), style });

const CELL: TagHandlers<SheetCell, [CellStyle, Ctx], SheetCell> = {
  CellText: (c, style) => new CellText({ value: c.value, style }),
  CellBlank: (_, style) => new CellBlank({ style }),
  CellNumber: typedCell<CellNumber>(
    "cell.number",
    "number cell converted to text",
    (c, style) => new CellNumber({ value: c.value, style }),
    cellText,
  ),
  CellBoolean: typedCell<CellBoolean>(
    "cell.boolean",
    "boolean cell converted to text",
    (c, style) => new CellBoolean({ value: c.value, style }),
    cellText,
  ),
  CellDate: typedCell<CellDate>(
    "cell.date",
    "date cell converted to ISO text",
    (c, style) => new CellDate({ value: c.value, style }),
    cellText,
  ),
  CellError: typedCell(
    "cell.error",
    "error cell converted to text",
    (c, style) => new CellError({ value: c.value, style }),
    (c, style) => new CellText({ value: c.value, style }),
  ),
  CellFormula: typedCell(
    "cell.formula",
    "formula cell converted to its cached result",
    (c, style) => new CellFormula({ formula: c.formula, result: c.result, style }),
    (c, style) => new CellText({ value: c.result ?? "", style }),
  ),
  CellRichText: typedCell(
    "cell.richText",
    "rich-text cell flattened to text",
    (c, style, ctx) => new CellRichText({ runs: narrowInlines(c.runs, ctx), style }),
    (c, style) => new CellText({ value: inlinesToText(c.runs), style }),
  ),
};

const narrowCell = (c: SheetCell, ctx: Ctx): SheetCell => {
  let style = c.style;
  if (style !== undefined && !ctx.allowed.has("cell.style")) {
    ctx.rec.drop("cell.style", "cell styling dropped");
    style = undefined;
  }
  return dispatchTag(CELL, c, style, ctx);
};

const narrowWorksheet = (w: Worksheet, ctx: Ctx): Worksheet => {
  const has = (f: Feature) => ctx.allowed.has(f);
  let merges = w.merges;
  if (Arr.isReadonlyArrayNonEmpty(merges) && !has("sheet.merges")) {
    ctx.rec.drop("sheet.merges", "merged ranges dropped");
    merges = [];
  }
  let columns = w.columns;
  if (Arr.isReadonlyArrayNonEmpty(columns) && !has("sheet.columns")) {
    ctx.rec.drop("sheet.columns", "column metadata dropped");
    columns = [];
  } else if (!has("cell.style")) {
    // sheet.columns is allowed, but per-column styling is not.
    let recorded = false;
    columns = columns.map((c) => {
      if (c.style === undefined) return c;
      if (!recorded) {
        ctx.rec.drop("cell.style", "column styling dropped");
        recorded = true;
      }
      return new SheetColumn({ width: c.width });
    });
  }
  return new Worksheet({
    attr: narrowAttr(w.attr, ctx),
    name: w.name,
    columns,
    rows: w.rows.map(
      (r) =>
        new SheetRow({
          index: r.index,
          cells: r.cells.map((c) => new IndexedCell({ col: c.col, cell: narrowCell(c.cell, ctx) })),
          height: r.height,
        }),
    ),
    merges,
  });
};

const worksheetToTable = (w: Worksheet, ctx: Ctx): Block[] => {
  // A prose table has no column positions, so it takes the dense view; a
  // sheet whose grid is over budget (one cell far out is billions of blanks)
  // is dropped and reported rather than laid out.
  const grid = denseRows(w);
  if (Result.isFailure(grid)) {
    ctx.rec.drop(
      "sheet.worksheet",
      `worksheet "${w.name}" dropped: ${grid.failure.message}, too large to lay out as a prose table`,
    );
    return [];
  }
  const rows = grid.success.map(
    (row) =>
      new TableRow({
        cells: row.map(
          (c) =>
            new TableCell({
              content: [new Plain({ content: [new Str({ text: cellToText(c) })] })],
            }),
        ),
      }),
  );
  ctx.rec.convert("sheet.worksheet", `worksheet "${w.name}" converted to a prose table`);
  // Re-narrow: the produced Table carries the worksheet's attr and Plain/Str
  // cells, which must themselves be checked against the target profile.
  return narrowBlocks(
    [new Table({ attr: w.attr, colSpecs: [], head: [], body: rows, foot: [] })],
    ctx,
  );
};

const tableToWorksheet = (t: Table, ctx: Ctx): Block[] => {
  const toCells = (row: TableRow): SheetCell[] =>
    row.cells.map((c) => new CellText({ value: blocksToText(c.content) }));
  const rows = [...t.head, ...t.body, ...t.foot].map((r, index) => sheetRow(index, toCells(r)));
  ctx.rec.convert("block.table", "prose table converted to a worksheet");
  // Re-narrow: the produced Worksheet carries the table's attr and CellText
  // cells, which must themselves be checked against the target profile.
  return narrowBlocks(
    [new Worksheet({ attr: t.attr, name: "Sheet1", columns: [], rows, merges: [] })],
    ctx,
  );
};

// ---- presentation ---------------------------------------------------------

/** A shape: kept (rebuilt) when the profile has `feature`, else dropped. */
const shape =
  <S extends Shape>(feature: Feature, detail: string, rebuild: (s: S, ctx: Ctx) => Shape) =>
  (s: S, ctx: Ctx): Shape[] => {
    if (ctx.allowed.has(feature)) return [rebuild(s, ctx)];
    ctx.rec.drop(feature, detail);
    return [];
  };

const SHAPE: TagHandlers<Shape, [Ctx], Shape[]> = {
  TextBox: shape(
    "shape.textBox",
    "text box dropped",
    (s, ctx) =>
      new TextBox({ attr: narrowAttr(s.attr, ctx), content: narrowBlocks(s.content, ctx) }),
  ),
  Picture: shape(
    "shape.picture",
    "picture dropped",
    (s, ctx) => new Picture({ attr: narrowAttr(s.attr, ctx), src: s.src, alt: s.alt }),
  ),
  TableShape: shape(
    "shape.table",
    "table shape dropped",
    (s, ctx) => new TableShape({ attr: narrowAttr(s.attr, ctx), table: narrowTable(s.table, ctx) }),
  ),
  Placeholder: shape(
    "shape.placeholder",
    "placeholder dropped",
    (s, ctx) =>
      new Placeholder({
        attr: narrowAttr(s.attr, ctx),
        placeholderType: s.placeholderType,
        idx: s.idx,
        content: narrowBlocks(s.content, ctx),
      }),
  ),
};

const narrowShape = (s: Shape, ctx: Ctx): Shape[] => dispatchTag(SHAPE, s, ctx);

const narrowSlideShow = (d: SlideShow, ctx: Ctx): SlideShow => {
  const slides = d.slides.map((sl) => {
    let notes = sl.notes;
    if (notes !== undefined && !ctx.allowed.has("deck.notes")) {
      ctx.rec.drop("deck.notes", "speaker notes dropped");
      notes = undefined;
    }
    return new Slide({
      attr: narrowAttr(sl.attr, ctx),
      layout: sl.layout,
      shapes: sl.shapes.flatMap((sh) => narrowShape(sh, ctx)),
      notes: notes === undefined ? undefined : narrowBlocks(notes, ctx),
    });
  });
  return new SlideShow({ attr: narrowAttr(d.attr, ctx), size: d.size, slides });
};

// ---- prose table ----------------------------------------------------------

const narrowTableRow = (r: TableRow, ctx: Ctx): TableRow =>
  new TableRow({
    cells: r.cells.map(
      (c) =>
        new TableCell({
          attr: narrowAttr(c.attr, ctx),
          align: c.align,
          rowSpan: c.rowSpan,
          colSpan: c.colSpan,
          content: narrowBlocks(c.content, ctx),
        }),
    ),
  });

const narrowTable = (t: Table, ctx: Ctx): Table =>
  new Table({
    attr: narrowAttr(t.attr, ctx),
    caption: t.caption === undefined ? undefined : narrowInlines(t.caption, ctx),
    colSpecs: t.colSpecs,
    head: t.head.map((r) => narrowTableRow(r, ctx)),
    body: t.body.map((r) => narrowTableRow(r, ctx)),
    foot: t.foot.map((r) => narrowTableRow(r, ctx)),
  });

// ---- blocks ---------------------------------------------------------------

const blockFeature = (tag: Block["_tag"]): Feature =>
  Match.value(tag).pipe(
    Match.when("Worksheet", (): Feature => "sheet.worksheet"),
    Match.when("SlideShow", (): Feature => "deck.slideShow"),
    Match.orElse(
      (): Feature =>
        // SAFETY: every other block tag `T` has the feature `block.<t>` (the
        // tag with its first letter lower-cased); `feature.ts` lists them all.
        `block.${tag.charAt(0).toLowerCase()}${tag.slice(1)}` as Feature,
    ),
  );

const narrowBlocks = (blocks: ReadonlyArray<Block>, ctx: Ctx): Block[] =>
  blocks.flatMap((b) => narrowBlock(b, ctx));

/** A slide shape's block content, for flattening a deck into prose. */
const shapeBlocks = (sh: Shape): ReadonlyArray<Block> =>
  Predicate.isTagged(sh, "TextBox") || Predicate.isTagged(sh, "Placeholder")
    ? sh.content
    : Predicate.isTagged(sh, "TableShape")
      ? [sh.table]
      : [];

/** Rewrite a block the profile lacks (`feature`) as blocks it may have, re-narrowed. */
const FALLBACK: TagHandlers<Block, [Feature, Ctx], Block[]> = {
  Header: (b, feature, ctx) => {
    const inner = narrowInlines(b.content, ctx);
    ctx.rec.convert(feature, "heading converted to a paragraph");
    return narrowBlock(new Para({ content: inner }), ctx);
  },
  BlockQuote: (b, feature, ctx) => {
    ctx.rec.convert(feature, `${b._tag} unwrapped to its contents`);
    return narrowBlocks(b.content, ctx);
  },
  Div: (b, feature, ctx) => {
    ctx.rec.convert(feature, `${b._tag} unwrapped to its contents`);
    return narrowBlocks(b.content, ctx);
  },
  Figure: (b, feature, ctx) => {
    ctx.rec.convert(feature, "figure unwrapped to caption + contents");
    return narrowBlocks([...b.caption, ...b.content], ctx);
  },
  OrderedList: (b, feature, ctx) => {
    ctx.rec.convert(feature, "list flattened to its item blocks");
    return narrowBlocks(b.items.flat(), ctx);
  },
  BulletList: (b, feature, ctx) => {
    ctx.rec.convert(feature, "list flattened to its item blocks");
    return narrowBlocks(b.items.flat(), ctx);
  },
  DefinitionList: (b, feature, ctx) => {
    ctx.rec.convert(feature, "definition list flattened");
    return narrowBlocks(
      b.items.flatMap((it) => [new Para({ content: it.term }), ...it.definitions.flat()]),
      ctx,
    );
  },
  LineBlock: (b, feature, ctx) => {
    ctx.rec.convert(feature, "line block converted to a paragraph");
    return narrowBlock(new Para({ content: b.lines.flat() }), ctx);
  },
  CodeBlock: (b, feature, ctx) => {
    ctx.rec.convert(feature, `${b._tag} converted to a paragraph`);
    return narrowBlock(new Para({ content: [new Str({ text: b.text })] }), ctx);
  },
  RawBlock: (b, feature, ctx) => {
    ctx.rec.convert(feature, `${b._tag} converted to a paragraph`);
    return narrowBlock(new Para({ content: [new Str({ text: b.text })] }), ctx);
  },
  Table: (b, feature, ctx) => {
    if (ctx.allowed.has("sheet.worksheet")) return tableToWorksheet(b, ctx);
    ctx.rec.drop(feature, "table dropped (target cannot represent tables)");
    return [];
  },
  Worksheet: (b, feature, ctx) => {
    if (ctx.allowed.has("block.table")) return worksheetToTable(b, ctx);
    ctx.rec.drop(feature, "worksheet dropped (target cannot represent grids)");
    return [];
  },
  SlideShow: (b, feature, ctx) => {
    ctx.rec.convert(feature, "slides flattened to their block content");
    return narrowBlocks(
      b.slides.flatMap((s) => [...s.shapes.flatMap(shapeBlocks), ...(s.notes ?? [])]),
      ctx,
    );
  },
  Para: (b, feature, ctx) => {
    ctx.rec.drop(feature, `${b._tag} dropped`);
    return [];
  },
  Plain: (b, feature, ctx) => {
    ctx.rec.drop(feature, `${b._tag} dropped`);
    return [];
  },
  HorizontalRule: (_, feature, ctx) => {
    ctx.rec.drop(feature, "horizontal rule dropped");
    return [];
  },
};

/** Narrow the contents of a block the profile has. */
const KEEP: TagHandlers<Block, [Ctx], Block[]> = {
  Plain: (b, ctx) => [new Plain({ content: narrowInlines(b.content, ctx) })],
  Para: (b, ctx) => [new Para({ content: narrowInlines(b.content, ctx) })],
  Header: (b, ctx) => [
    new Header({
      level: b.level,
      attr: narrowAttr(b.attr, ctx),
      content: narrowInlines(b.content, ctx),
    }),
  ],
  BlockQuote: (b, ctx) => [new BlockQuote({ content: narrowBlocks(b.content, ctx) })],
  Div: (b, ctx) => [
    new Div({ attr: narrowAttr(b.attr, ctx), content: narrowBlocks(b.content, ctx) }),
  ],
  Figure: (b, ctx) => [
    new Figure({
      attr: narrowAttr(b.attr, ctx),
      caption: narrowBlocks(b.caption, ctx),
      content: narrowBlocks(b.content, ctx),
    }),
  ],
  OrderedList: (b, ctx) => [
    new OrderedList({
      attr: narrowAttr(b.attr, ctx),
      start: b.start,
      numberStyle: b.numberStyle,
      numberDelim: b.numberDelim,
      items: b.items.map((it) => narrowBlocks(it, ctx)),
    }),
  ],
  BulletList: (b, ctx) => [
    new BulletList({
      attr: narrowAttr(b.attr, ctx),
      items: b.items.map((it) => narrowBlocks(it, ctx)),
    }),
  ],
  Table: (b, ctx) => [narrowTable(b, ctx)],
  Worksheet: (b, ctx) => [narrowWorksheet(b, ctx)],
  SlideShow: (b, ctx) => [narrowSlideShow(b, ctx)],
  // no inline content or attributes to narrow
  DefinitionList: (b) => [b],
  LineBlock: (b) => [b],
  CodeBlock: (b) => [b],
  RawBlock: (b) => [b],
  HorizontalRule: (b) => [b],
};

const narrowBlock = (b: Block, ctx: Ctx): Block[] => {
  const feature = blockFeature(b._tag);
  return ctx.allowed.has(feature)
    ? dispatchTag(KEEP, b, ctx)
    : dispatchTag(FALLBACK, b, feature, ctx);
};

/**
 * Narrow a document so it conforms to `to`, recording everything that had to be
 * dropped or down-converted.
 */
export const narrow = <To extends Feature>(doc: Document, to: Profile<To>): NarrowResult<To> => {
  const ctx: Ctx = { allowed: to.features, rec: new Recorder() };
  let blocks = [...doc.blocks];

  const worksheets = blocks.filter((b) => Predicate.isTagged(b, "Worksheet"));
  if (worksheets.length > 1 && !ctx.allowed.has("sheet.multiple")) {
    // The target cannot represent multiple worksheets, so "keep" is not
    // honorable here - we must reduce to the first sheet and report the loss.
    let seen = false;
    blocks = blocks.filter((b) => {
      if (!Predicate.isTagged(b, "Worksheet")) return true;
      if (seen) return false;
      seen = true;
      return true;
    });
    ctx.rec.drop("sheet.multiple", `kept first of ${worksheets.length} worksheets`);
  }

  const narrowed = narrowBlocks(blocks, ctx);
  // SAFETY: `narrowBlocks` rebuilt every node through the `ctx.allowed` check,
  // so the tree uses only the target profile's features.
  const document = new Document({ meta: doc.meta, blocks: narrowed }) as Doc<To>;
  return {
    document,
    loss: { entries: ctx.rec.entries, isLossless: Arr.isReadonlyArrayEmpty(ctx.rec.entries) },
  };
};

/** Narrow within an Effect. */
export const narrowEffect = <To extends Feature>(
  doc: Document,
  to: Profile<To>,
): Effect.Effect<NarrowResult<To>, never> => Effect.sync(() => narrow(doc, to));
