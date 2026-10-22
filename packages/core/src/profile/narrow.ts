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

import { Effect } from "effect";
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
import { type Feature } from "../schema/feature.ts";
import { type Doc, type Profile } from "./profile.ts";

// ============================================================================
// Loss report
// ============================================================================

export interface LossEntry {
  /** The feature that could not be represented. */
  readonly feature: Feature;
  /** What happened: dropped, or down-converted to something simpler. */
  readonly action: "dropped" | "converted";
  /** A short human-readable explanation. */
  readonly detail: string;
}

export interface LossReport {
  readonly entries: ReadonlyArray<LossEntry>;
  /** True when nothing was lost (the narrowing was a no-op). */
  readonly isLossless: boolean;
}

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

const narrowAttr = (attr: Attributes | undefined, ctx: Ctx): Attributes | undefined => {
  if (attr === undefined) return undefined;
  const out: { -readonly [K in keyof Attributes]: Attributes[K] } = {};
  if (attr.id !== undefined) {
    if (ctx.allowed.has("attr.id")) out.id = attr.id;
    else ctx.rec.drop("attr.id", "format does not support element ids");
  }
  if (attr.classes !== undefined && attr.classes.length > 0) {
    if (ctx.allowed.has("attr.classes")) out.classes = attr.classes;
    else ctx.rec.drop("attr.classes", "format does not support classes");
  }
  if (attr.style !== undefined) {
    if (ctx.allowed.has("attr.style")) out.style = attr.style;
    else ctx.rec.drop("attr.style", "format does not support inline styling");
  }
  if (attr.data !== undefined && Object.keys(attr.data).length > 0) {
    if (ctx.allowed.has("attr.keyValue")) out.data = attr.data;
    else ctx.rec.drop("attr.keyValue", "format does not support custom attributes");
  }
  return Object.keys(out).length > 0 ? out : undefined;
};

// ---- inlines --------------------------------------------------------------

const narrowInlines = (inlines: ReadonlyArray<Inline>, ctx: Ctx): Inline[] =>
  inlines.flatMap((i) => narrowInline(i, ctx));

const narrowInline = (n: Inline, ctx: Ctx): Inline[] => {
  const has = (f: Feature) => ctx.allowed.has(f);
  switch (n._tag) {
    case "Str":
    case "Space":
    case "SoftBreak":
    case "LineBreak":
      return [n];
    case "Emph": {
      const inner = narrowInlines(n.content, ctx);
      if (has("inline.emph")) return [new Emph({ content: inner })];
      ctx.rec.convert("inline.emph", "Emph unwrapped to its text");
      return inner;
    }
    case "Strong": {
      const inner = narrowInlines(n.content, ctx);
      if (has("inline.strong")) return [new Strong({ content: inner })];
      ctx.rec.convert("inline.strong", "Strong unwrapped to its text");
      return inner;
    }
    case "Underline": {
      const inner = narrowInlines(n.content, ctx);
      if (has("inline.underline")) return [new Underline({ content: inner })];
      ctx.rec.convert("inline.underline", "Underline unwrapped to its text");
      return inner;
    }
    case "Strikeout": {
      const inner = narrowInlines(n.content, ctx);
      if (has("inline.strikeout")) return [new Strikeout({ content: inner })];
      ctx.rec.convert("inline.strikeout", "Strikeout unwrapped to its text");
      return inner;
    }
    case "Superscript": {
      const inner = narrowInlines(n.content, ctx);
      if (has("inline.superscript")) return [new Superscript({ content: inner })];
      ctx.rec.convert("inline.superscript", "Superscript unwrapped to its text");
      return inner;
    }
    case "Subscript": {
      const inner = narrowInlines(n.content, ctx);
      if (has("inline.subscript")) return [new Subscript({ content: inner })];
      ctx.rec.convert("inline.subscript", "Subscript unwrapped to its text");
      return inner;
    }
    case "SmallCaps": {
      const inner = narrowInlines(n.content, ctx);
      if (has("inline.smallCaps")) return [new SmallCaps({ content: inner })];
      ctx.rec.convert("inline.smallCaps", "SmallCaps unwrapped to its text");
      return inner;
    }
    case "Quoted": {
      const inner = narrowInlines(n.content, ctx);
      if (has("inline.quoted")) return [new Quoted({ quoteType: n.quoteType, content: inner })];
      ctx.rec.convert("inline.quoted", "Quoted unwrapped to its text");
      return inner;
    }
    case "Span": {
      const inner = narrowInlines(n.content, ctx);
      if (has("inline.span")) return [new Span({ attr: narrowAttr(n.attr, ctx), content: inner })];
      ctx.rec.convert("inline.span", "Span unwrapped to its content");
      return inner;
    }
    case "Link": {
      const inner = narrowInlines(n.content, ctx);
      if (has("inline.link"))
        return [new Link({ attr: narrowAttr(n.attr, ctx), content: inner, target: n.target })];
      ctx.rec.convert("inline.link", "Link reduced to its text");
      return inner;
    }
    case "Image":
      if (has("inline.image"))
        return [
          new Image({
            attr: narrowAttr(n.attr, ctx),
            alt: narrowInlines(n.alt, ctx),
            target: n.target,
          }),
        ];
      ctx.rec.convert("inline.image", "Image reduced to its alt text");
      return narrowInlines(n.alt, ctx);
    case "Code":
      if (has("inline.code")) return [new Code({ attr: narrowAttr(n.attr, ctx), text: n.text })];
      ctx.rec.convert("inline.code", "Code reduced to text");
      return [new Str({ text: n.text })];
    case "Math":
      if (has("inline.math")) return [new Math({ mathType: n.mathType, text: n.text })];
      ctx.rec.convert("inline.math", "Math reduced to text");
      return [new Str({ text: n.text })];
    case "Cite":
      if (has("inline.cite")) {
        return [
          new Cite({
            citations: n.citations.map(
              (c) =>
                new Citation({
                  id: c.id,
                  mode: c.mode,
                  prefix: narrowInlines(c.prefix, ctx),
                  suffix: narrowInlines(c.suffix, ctx),
                }),
            ),
            content: narrowInlines(n.content, ctx),
          }),
        ];
      }
      ctx.rec.convert("inline.cite", "Cite reduced to its text");
      return narrowInlines(n.content, ctx);
    case "RawInline":
      if (has("inline.rawInline")) return [new RawInline({ format: n.format, text: n.text })];
      ctx.rec.drop("inline.rawInline", "raw inline content dropped");
      return [];
    case "Note":
      if (has("inline.note")) return [new Note({ content: narrowBlocks(n.content, ctx) })];
      ctx.rec.drop("inline.note", "note dropped");
      return [];
  }
};

// ---- spreadsheet ----------------------------------------------------------

const narrowCell = (c: SheetCell, ctx: Ctx): SheetCell => {
  const has = (f: Feature) => ctx.allowed.has(f);
  let style = c.style;
  if (style !== undefined && !has("cell.style")) {
    ctx.rec.drop("cell.style", "cell styling dropped");
    style = undefined;
  }
  switch (c._tag) {
    case "CellText":
      return new CellText({ value: c.value, style });
    case "CellBlank":
      return new CellBlank({ style });
    case "CellNumber":
      if (has("cell.number")) return new CellNumber({ value: c.value, style });
      ctx.rec.convert("cell.number", "number cell converted to text");
      return new CellText({ value: cellToText(c), style });
    case "CellBoolean":
      if (has("cell.boolean")) return new CellBoolean({ value: c.value, style });
      ctx.rec.convert("cell.boolean", "boolean cell converted to text");
      return new CellText({ value: cellToText(c), style });
    case "CellDate":
      if (has("cell.date")) return new CellDate({ value: c.value, style });
      ctx.rec.convert("cell.date", "date cell converted to ISO text");
      return new CellText({ value: cellToText(c), style });
    case "CellError":
      if (has("cell.error")) return new CellError({ value: c.value, style });
      ctx.rec.convert("cell.error", "error cell converted to text");
      return new CellText({ value: c.value, style });
    case "CellFormula":
      if (has("cell.formula"))
        return new CellFormula({ formula: c.formula, result: c.result, style });
      ctx.rec.convert("cell.formula", "formula cell converted to its cached result");
      return new CellText({ value: c.result ?? "", style });
    case "CellRichText":
      if (has("cell.richText"))
        return new CellRichText({ runs: narrowInlines(c.runs, ctx), style });
      ctx.rec.convert("cell.richText", "rich-text cell flattened to text");
      return new CellText({ value: inlinesToText(c.runs), style });
  }
};

const narrowWorksheet = (w: Worksheet, ctx: Ctx): Worksheet => {
  const has = (f: Feature) => ctx.allowed.has(f);
  let merges = w.merges;
  if (merges.length > 0 && !has("sheet.merges")) {
    ctx.rec.drop("sheet.merges", "merged ranges dropped");
    merges = [];
  }
  let columns = w.columns;
  if (columns.length > 0 && !has("sheet.columns")) {
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
      (r) => new SheetRow({ cells: r.cells.map((c) => narrowCell(c, ctx)), height: r.height }),
    ),
    merges,
  });
};

const worksheetToTable = (w: Worksheet, ctx: Ctx): Block[] => {
  const rows = w.rows.map(
    (row) =>
      new TableRow({
        cells: row.cells.map(
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
  const rows = [...t.head, ...t.body, ...t.foot].map((r) => new SheetRow({ cells: toCells(r) }));
  ctx.rec.convert("block.table", "prose table converted to a worksheet");
  // Re-narrow: the produced Worksheet carries the table's attr and CellText
  // cells, which must themselves be checked against the target profile.
  return narrowBlocks(
    [new Worksheet({ attr: t.attr, name: "Sheet1", columns: [], rows, merges: [] })],
    ctx,
  );
};

// ---- presentation ---------------------------------------------------------

const narrowShape = (s: Shape, ctx: Ctx): Shape[] => {
  const has = (f: Feature) => ctx.allowed.has(f);
  switch (s._tag) {
    case "TextBox":
      if (has("shape.textBox"))
        return [
          new TextBox({ attr: narrowAttr(s.attr, ctx), content: narrowBlocks(s.content, ctx) }),
        ];
      ctx.rec.drop("shape.textBox", "text box dropped");
      return [];
    case "Picture":
      if (has("shape.picture"))
        return [new Picture({ attr: narrowAttr(s.attr, ctx), src: s.src, alt: s.alt })];
      ctx.rec.drop("shape.picture", "picture dropped");
      return [];
    case "TableShape":
      if (has("shape.table"))
        return [
          new TableShape({ attr: narrowAttr(s.attr, ctx), table: narrowTable(s.table, ctx) }),
        ];
      ctx.rec.drop("shape.table", "table shape dropped");
      return [];
    case "Placeholder":
      if (has("shape.placeholder"))
        return [
          new Placeholder({
            attr: narrowAttr(s.attr, ctx),
            placeholderType: s.placeholderType,
            idx: s.idx,
            content: narrowBlocks(s.content, ctx),
          }),
        ];
      ctx.rec.drop("shape.placeholder", "placeholder dropped");
      return [];
  }
};

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

const blockFeature = (tag: Block["_tag"]): Feature => {
  switch (tag) {
    case "Worksheet":
      return "sheet.worksheet";
    case "SlideShow":
      return "deck.slideShow";
    default:
      return `block.${tag[0]!.toLowerCase()}${tag.slice(1)}` as Feature;
  }
};

const narrowBlocks = (blocks: ReadonlyArray<Block>, ctx: Ctx): Block[] =>
  blocks.flatMap((b) => narrowBlock(b, ctx));

const narrowBlock = (b: Block, ctx: Ctx): Block[] => {
  const feature = blockFeature(b._tag);
  const has = (f: Feature) => ctx.allowed.has(f);

  if (!has(feature)) {
    switch (b._tag) {
      case "Header": {
        const inner = narrowInlines(b.content, ctx);
        ctx.rec.convert(feature, "heading converted to a paragraph");
        return narrowBlock(new Para({ content: inner }), ctx);
      }
      case "BlockQuote":
      case "Div":
        ctx.rec.convert(feature, `${b._tag} unwrapped to its contents`);
        return narrowBlocks(b.content, ctx);
      case "Figure":
        ctx.rec.convert(feature, "figure unwrapped to caption + contents");
        return narrowBlocks([...b.caption, ...b.content], ctx);
      case "OrderedList":
      case "BulletList":
        ctx.rec.convert(feature, "list flattened to its item blocks");
        return narrowBlocks(b.items.flat(), ctx);
      case "DefinitionList":
        ctx.rec.convert(feature, "definition list flattened");
        return narrowBlocks(
          b.items.flatMap((it) => [new Para({ content: it.term }), ...it.definitions.flat()]),
          ctx,
        );
      case "LineBlock":
        ctx.rec.convert(feature, "line block converted to a paragraph");
        return narrowBlock(new Para({ content: b.lines.flat() }), ctx);
      case "CodeBlock":
      case "RawBlock":
        ctx.rec.convert(feature, `${b._tag} converted to a paragraph`);
        return narrowBlock(new Para({ content: [new Str({ text: b.text })] }), ctx);
      case "Table":
        if (has("sheet.worksheet")) return tableToWorksheet(b, ctx);
        ctx.rec.drop(feature, "table dropped (target cannot represent tables)");
        return [];
      case "Worksheet":
        if (has("block.table")) return worksheetToTable(b, ctx);
        ctx.rec.drop(feature, "worksheet dropped (target cannot represent grids)");
        return [];
      case "SlideShow":
        ctx.rec.convert(feature, "slides flattened to their block content");
        return narrowBlocks(
          b.slides.flatMap((s) => [
            ...s.shapes.flatMap((sh): ReadonlyArray<Block> =>
              sh._tag === "TextBox" || sh._tag === "Placeholder"
                ? sh.content
                : sh._tag === "TableShape"
                  ? [sh.table]
                  : [],
            ),
            ...(s.notes ?? []),
          ]),
          ctx,
        );
      case "Para":
      case "Plain":
        ctx.rec.drop(feature, `${b._tag} dropped`);
        return [];
      case "HorizontalRule":
        ctx.rec.drop(feature, "horizontal rule dropped");
        return [];
    }
  }

  switch (b._tag) {
    case "Plain":
      return [new Plain({ content: narrowInlines(b.content, ctx) })];
    case "Para":
      return [new Para({ content: narrowInlines(b.content, ctx) })];
    case "Header":
      return [
        new Header({
          level: b.level,
          attr: narrowAttr(b.attr, ctx),
          content: narrowInlines(b.content, ctx),
        }),
      ];
    case "BlockQuote":
      return [new BlockQuote({ content: narrowBlocks(b.content, ctx) })];
    case "Div":
      return [new Div({ attr: narrowAttr(b.attr, ctx), content: narrowBlocks(b.content, ctx) })];
    case "Figure":
      return [
        new Figure({
          attr: narrowAttr(b.attr, ctx),
          caption: narrowBlocks(b.caption, ctx),
          content: narrowBlocks(b.content, ctx),
        }),
      ];
    case "OrderedList":
      return [
        new OrderedList({
          attr: narrowAttr(b.attr, ctx),
          start: b.start,
          numberStyle: b.numberStyle,
          numberDelim: b.numberDelim,
          items: b.items.map((it) => narrowBlocks(it, ctx)),
        }),
      ];
    case "BulletList":
      return [
        new BulletList({
          attr: narrowAttr(b.attr, ctx),
          items: b.items.map((it) => narrowBlocks(it, ctx)),
        }),
      ];
    case "Table":
      return [narrowTable(b, ctx)];
    case "Worksheet":
      return [narrowWorksheet(b, ctx)];
    case "SlideShow":
      return [narrowSlideShow(b, ctx)];
    default:
      return [b];
  }
};

/**
 * Narrow a document so it conforms to `to`, recording everything that had to be
 * dropped or down-converted.
 */
export const narrow = <To extends Feature>(doc: Document, to: Profile<To>): NarrowResult<To> => {
  const ctx: Ctx = { allowed: to.features, rec: new Recorder() };
  let blocks = [...doc.blocks];

  const worksheets = blocks.filter((b) => b._tag === "Worksheet");
  if (worksheets.length > 1 && !ctx.allowed.has("sheet.multiple")) {
    // The target cannot represent multiple worksheets, so "keep" is not
    // honorable here - we must reduce to the first sheet and report the loss.
    let seen = false;
    blocks = blocks.filter((b) => {
      if (b._tag !== "Worksheet") return true;
      if (seen) return false;
      seen = true;
      return true;
    });
    ctx.rec.drop("sheet.multiple", `kept first of ${worksheets.length} worksheets`);
  }

  const narrowed = narrowBlocks(blocks, ctx);
  const document = new Document({ meta: doc.meta, blocks: narrowed }) as Doc<To>;
  return {
    document,
    loss: { entries: ctx.rec.entries, isLossless: ctx.rec.entries.length === 0 },
  };
};

/** Narrow within an Effect. */
export const narrowEffect = <To extends Feature>(
  doc: Document,
  to: Profile<To>,
): Effect.Effect<NarrowResult<To>, never> => Effect.sync(() => narrow(doc, to));
