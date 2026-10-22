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

const narrowInline = (n: Inline, ctx: Ctx): Inline[] => {
  const has = (f: Feature) => ctx.allowed.has(f);
  if (Predicate.isTagged(n, "Emph")) {
    const inner = narrowInlines(n.content, ctx);
    if (has("inline.emph")) return [new Emph({ content: inner })];
    ctx.rec.convert("inline.emph", "Emph unwrapped to its text");
    return inner;
  }
  if (Predicate.isTagged(n, "Strong")) {
    const inner = narrowInlines(n.content, ctx);
    if (has("inline.strong")) return [new Strong({ content: inner })];
    ctx.rec.convert("inline.strong", "Strong unwrapped to its text");
    return inner;
  }
  if (Predicate.isTagged(n, "Underline")) {
    const inner = narrowInlines(n.content, ctx);
    if (has("inline.underline")) return [new Underline({ content: inner })];
    ctx.rec.convert("inline.underline", "Underline unwrapped to its text");
    return inner;
  }
  if (Predicate.isTagged(n, "Strikeout")) {
    const inner = narrowInlines(n.content, ctx);
    if (has("inline.strikeout")) return [new Strikeout({ content: inner })];
    ctx.rec.convert("inline.strikeout", "Strikeout unwrapped to its text");
    return inner;
  }
  if (Predicate.isTagged(n, "Superscript")) {
    const inner = narrowInlines(n.content, ctx);
    if (has("inline.superscript")) return [new Superscript({ content: inner })];
    ctx.rec.convert("inline.superscript", "Superscript unwrapped to its text");
    return inner;
  }
  if (Predicate.isTagged(n, "Subscript")) {
    const inner = narrowInlines(n.content, ctx);
    if (has("inline.subscript")) return [new Subscript({ content: inner })];
    ctx.rec.convert("inline.subscript", "Subscript unwrapped to its text");
    return inner;
  }
  if (Predicate.isTagged(n, "SmallCaps")) {
    const inner = narrowInlines(n.content, ctx);
    if (has("inline.smallCaps")) return [new SmallCaps({ content: inner })];
    ctx.rec.convert("inline.smallCaps", "SmallCaps unwrapped to its text");
    return inner;
  }
  if (Predicate.isTagged(n, "Quoted")) {
    const inner = narrowInlines(n.content, ctx);
    if (has("inline.quoted")) return [new Quoted({ quoteType: n.quoteType, content: inner })];
    ctx.rec.convert("inline.quoted", "Quoted unwrapped to its text");
    return inner;
  }
  if (Predicate.isTagged(n, "Span")) {
    const inner = narrowInlines(n.content, ctx);
    if (has("inline.span")) return [new Span({ attr: narrowAttr(n.attr, ctx), content: inner })];
    ctx.rec.convert("inline.span", "Span unwrapped to its content");
    return inner;
  }
  if (Predicate.isTagged(n, "Link")) {
    const inner = narrowInlines(n.content, ctx);
    if (has("inline.link"))
      return [new Link({ attr: narrowAttr(n.attr, ctx), content: inner, target: n.target })];
    ctx.rec.convert("inline.link", "Link reduced to its text");
    return inner;
  }
  if (Predicate.isTagged(n, "Image")) {
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
  }
  if (Predicate.isTagged(n, "Code")) {
    if (has("inline.code")) return [new Code({ attr: narrowAttr(n.attr, ctx), text: n.text })];
    ctx.rec.convert("inline.code", "Code reduced to text");
    return [new Str({ text: n.text })];
  }
  if (Predicate.isTagged(n, "Math")) {
    if (has("inline.math")) return [new Math({ mathType: n.mathType, text: n.text })];
    ctx.rec.convert("inline.math", "Math reduced to text");
    return [new Str({ text: n.text })];
  }
  if (Predicate.isTagged(n, "Cite")) {
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
  }
  if (Predicate.isTagged(n, "RawInline")) {
    if (has("inline.rawInline")) return [new RawInline({ format: n.format, text: n.text })];
    ctx.rec.drop("inline.rawInline", "raw inline content dropped");
    return [];
  }
  if (Predicate.isTagged(n, "Note")) {
    if (has("inline.note")) return [new Note({ content: narrowBlocks(n.content, ctx) })];
    ctx.rec.drop("inline.note", "note dropped");
    return [];
  }
  // Str, Space, SoftBreak and LineBreak are in every profile
  return [n];
};

// ---- spreadsheet ----------------------------------------------------------

const narrowCell = (c: SheetCell, ctx: Ctx): SheetCell => {
  const has = (f: Feature) => ctx.allowed.has(f);
  let style = c.style;
  if (style !== undefined && !has("cell.style")) {
    ctx.rec.drop("cell.style", "cell styling dropped");
    style = undefined;
  }
  if (Predicate.isTagged(c, "CellText")) {
    return new CellText({ value: c.value, style });
  }
  if (Predicate.isTagged(c, "CellBlank")) {
    return new CellBlank({ style });
  }
  if (Predicate.isTagged(c, "CellNumber")) {
    if (has("cell.number")) return new CellNumber({ value: c.value, style });
    ctx.rec.convert("cell.number", "number cell converted to text");
    return new CellText({ value: cellToText(c), style });
  }
  if (Predicate.isTagged(c, "CellBoolean")) {
    if (has("cell.boolean")) return new CellBoolean({ value: c.value, style });
    ctx.rec.convert("cell.boolean", "boolean cell converted to text");
    return new CellText({ value: cellToText(c), style });
  }
  if (Predicate.isTagged(c, "CellDate")) {
    if (has("cell.date")) return new CellDate({ value: c.value, style });
    ctx.rec.convert("cell.date", "date cell converted to ISO text");
    return new CellText({ value: cellToText(c), style });
  }
  if (Predicate.isTagged(c, "CellError")) {
    if (has("cell.error")) return new CellError({ value: c.value, style });
    ctx.rec.convert("cell.error", "error cell converted to text");
    return new CellText({ value: c.value, style });
  }
  if (Predicate.isTagged(c, "CellFormula")) {
    if (has("cell.formula"))
      return new CellFormula({ formula: c.formula, result: c.result, style });
    ctx.rec.convert("cell.formula", "formula cell converted to its cached result");
    return new CellText({ value: c.result ?? "", style });
  }
  if (has("cell.richText")) return new CellRichText({ runs: narrowInlines(c.runs, ctx), style });
  ctx.rec.convert("cell.richText", "rich-text cell flattened to text");
  return new CellText({ value: inlinesToText(c.runs), style });
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
  if (Predicate.isTagged(s, "TextBox")) {
    if (has("shape.textBox"))
      return [
        new TextBox({ attr: narrowAttr(s.attr, ctx), content: narrowBlocks(s.content, ctx) }),
      ];
    ctx.rec.drop("shape.textBox", "text box dropped");
    return [];
  }
  if (Predicate.isTagged(s, "Picture")) {
    if (has("shape.picture"))
      return [new Picture({ attr: narrowAttr(s.attr, ctx), src: s.src, alt: s.alt })];
    ctx.rec.drop("shape.picture", "picture dropped");
    return [];
  }
  if (Predicate.isTagged(s, "TableShape")) {
    if (has("shape.table"))
      return [new TableShape({ attr: narrowAttr(s.attr, ctx), table: narrowTable(s.table, ctx) })];
    ctx.rec.drop("shape.table", "table shape dropped");
    return [];
  }
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

const narrowBlock = (b: Block, ctx: Ctx): Block[] => {
  const feature = blockFeature(b._tag);
  const has = (f: Feature) => ctx.allowed.has(f);

  if (!has(feature)) {
    if (Predicate.isTagged(b, "Header")) {
      const inner = narrowInlines(b.content, ctx);
      ctx.rec.convert(feature, "heading converted to a paragraph");
      return narrowBlock(new Para({ content: inner }), ctx);
    }
    if (Predicate.isTagged(b, "BlockQuote") || Predicate.isTagged(b, "Div")) {
      ctx.rec.convert(feature, `${b._tag} unwrapped to its contents`);
      return narrowBlocks(b.content, ctx);
    }
    if (Predicate.isTagged(b, "Figure")) {
      ctx.rec.convert(feature, "figure unwrapped to caption + contents");
      return narrowBlocks([...b.caption, ...b.content], ctx);
    }
    if (Predicate.isTagged(b, "OrderedList") || Predicate.isTagged(b, "BulletList")) {
      ctx.rec.convert(feature, "list flattened to its item blocks");
      return narrowBlocks(b.items.flat(), ctx);
    }
    if (Predicate.isTagged(b, "DefinitionList")) {
      ctx.rec.convert(feature, "definition list flattened");
      return narrowBlocks(
        b.items.flatMap((it) => [new Para({ content: it.term }), ...it.definitions.flat()]),
        ctx,
      );
    }
    if (Predicate.isTagged(b, "LineBlock")) {
      ctx.rec.convert(feature, "line block converted to a paragraph");
      return narrowBlock(new Para({ content: b.lines.flat() }), ctx);
    }
    if (Predicate.isTagged(b, "CodeBlock") || Predicate.isTagged(b, "RawBlock")) {
      ctx.rec.convert(feature, `${b._tag} converted to a paragraph`);
      return narrowBlock(new Para({ content: [new Str({ text: b.text })] }), ctx);
    }
    if (Predicate.isTagged(b, "Table")) {
      if (has("sheet.worksheet")) return tableToWorksheet(b, ctx);
      ctx.rec.drop(feature, "table dropped (target cannot represent tables)");
      return [];
    }
    if (Predicate.isTagged(b, "Worksheet")) {
      if (has("block.table")) return worksheetToTable(b, ctx);
      ctx.rec.drop(feature, "worksheet dropped (target cannot represent grids)");
      return [];
    }
    if (Predicate.isTagged(b, "SlideShow")) {
      ctx.rec.convert(feature, "slides flattened to their block content");
      return narrowBlocks(
        b.slides.flatMap((s) => [
          ...s.shapes.flatMap((sh): ReadonlyArray<Block> =>
            Predicate.isTagged(sh, "TextBox") || Predicate.isTagged(sh, "Placeholder")
              ? sh.content
              : Predicate.isTagged(sh, "TableShape")
                ? [sh.table]
                : [],
          ),
          ...(s.notes ?? []),
        ]),
        ctx,
      );
    }
    if (Predicate.isTagged(b, "Para") || Predicate.isTagged(b, "Plain")) {
      ctx.rec.drop(feature, `${b._tag} dropped`);
      return [];
    }
    ctx.rec.drop(feature, "horizontal rule dropped");
    return [];
  }

  if (Predicate.isTagged(b, "Plain")) {
    return [new Plain({ content: narrowInlines(b.content, ctx) })];
  }
  if (Predicate.isTagged(b, "Para")) {
    return [new Para({ content: narrowInlines(b.content, ctx) })];
  }
  if (Predicate.isTagged(b, "Header")) {
    return [
      new Header({
        level: b.level,
        attr: narrowAttr(b.attr, ctx),
        content: narrowInlines(b.content, ctx),
      }),
    ];
  }
  if (Predicate.isTagged(b, "BlockQuote")) {
    return [new BlockQuote({ content: narrowBlocks(b.content, ctx) })];
  }
  if (Predicate.isTagged(b, "Div")) {
    return [new Div({ attr: narrowAttr(b.attr, ctx), content: narrowBlocks(b.content, ctx) })];
  }
  if (Predicate.isTagged(b, "Figure")) {
    return [
      new Figure({
        attr: narrowAttr(b.attr, ctx),
        caption: narrowBlocks(b.caption, ctx),
        content: narrowBlocks(b.content, ctx),
      }),
    ];
  }
  if (Predicate.isTagged(b, "OrderedList")) {
    return [
      new OrderedList({
        attr: narrowAttr(b.attr, ctx),
        start: b.start,
        numberStyle: b.numberStyle,
        numberDelim: b.numberDelim,
        items: b.items.map((it) => narrowBlocks(it, ctx)),
      }),
    ];
  }
  if (Predicate.isTagged(b, "BulletList")) {
    return [
      new BulletList({
        attr: narrowAttr(b.attr, ctx),
        items: b.items.map((it) => narrowBlocks(it, ctx)),
      }),
    ];
  }
  if (Predicate.isTagged(b, "Table")) {
    return [narrowTable(b, ctx)];
  }
  if (Predicate.isTagged(b, "Worksheet")) {
    return [narrowWorksheet(b, ctx)];
  }
  if (Predicate.isTagged(b, "SlideShow")) {
    return [narrowSlideShow(b, ctx)];
  }
  return [b];
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
