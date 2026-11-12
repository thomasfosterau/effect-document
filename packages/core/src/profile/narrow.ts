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

import * as Option from "effect/Option";
import * as Rec from "effect/Record";
import * as Predicate from "effect/Predicate";
import * as Arr from "effect/Array";
import * as Result from "effect/Result";
import * as Effect from "effect/Effect";
import { isThreadComment } from "./collect.ts";
import { type Attributes } from "../schema/attributes.ts";
import {
  type Block,
  BlockQuote,
  BulletList,
  CellBlank,
  CellBoolean,
  CellComment,
  CellDate,
  CellError,
  CellFormula,
  CellNumber,
  CellRichText,
  CellText,
  Cite,
  Citation,
  Code,
  CodeBlock,
  Comment,
  DefinitionItem,
  DefinitionList,
  Div,
  Emph,
  Figure,
  Header,
  Image,
  type Inline,
  LineBlock,
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
  type RowCell,
  SheetRow,
  isPlainRow,
  type WorksheetRow,
  Slide,
  SlideShow,
  SmallCaps,
  Space,
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
import { cellOf, denseRows, rowCellsOf, rowIndexes, sheetRow } from "../schema/sheet.ts";
import { type Resources, resourceUrl } from "../schema/resource.ts";
import { type Feature, ID_FEATURE, type IdNode, TAG_FEATURE } from "../schema/feature.ts";
import { type Doc, type NotWithin, type Profile, trustAs } from "./profile.ts";
import {
  breaksWhole,
  childInlines,
  type FieldValues,
  fieldMatches,
  type OnlyWithin,
  type RuleNode,
  type Whole,
} from "./rules.ts";
import { dispatchTag, type TagHandlers } from "./dispatch.ts";
import {
  type LossEntry,
  type LossPathSegment,
  type LossReport,
  lossReport,
  severityOf,
} from "./loss.ts";

// ============================================================================
// Loss report
// ============================================================================

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
  // `From extends To`, and `Doc`'s feature parameter is a phantom in a
  // covariant position, so every `Doc<From>` is already a `Doc<To>`.
  doc;

// ============================================================================
// narrow
// ============================================================================

/**
 * Where `narrow` records losses: one shared list of entries, seen from a
 * position in the document. `at` gives the recorder for a child (sharing the
 * entries), and an entry's path is read up the chain only when one is
 * recorded, so positions cost nothing where nothing is lost.
 */
class Recorder {
  readonly entries: LossEntry[];
  /** Why features are lost here, beyond the generic detail: the reasons of the rules in force. */
  private readonly reasons: ReadonlyMap<Feature, string>;
  private readonly parent: Recorder | undefined;
  private readonly segment: LossPathSegment | undefined;
  constructor(
    entries: LossEntry[] = [],
    reasons: ReadonlyMap<Feature, string> = new Map(),
    parent?: Recorder,
    segment?: LossPathSegment,
  ) {
    this.entries = entries;
    this.reasons = reasons;
    this.parent = parent;
    this.segment = segment;
  }
  private detail(feature: Feature, detail: string): string {
    const reason = this.reasons.get(feature);
    return reason === undefined ? detail : `${detail}: ${reason}`;
  }
  /** The path from the document's blocks to this position (read up the chain, as deep as the node). */
  private path(): LossPathSegment[] {
    const up = this.parent === undefined ? [] : this.parent.path();
    if (this.segment !== undefined) up.push(this.segment);
    return up;
  }
  private record(feature: Feature, action: LossEntry["action"], detail: string): void {
    this.entries.push({
      feature,
      action,
      severity: severityOf(feature, action),
      path: this.path(),
      detail: this.detail(feature, detail),
    });
  }
  drop(feature: Feature, detail: string): void {
    this.record(feature, "dropped", detail);
  }
  convert(feature: Feature, detail: string): void {
    this.record(feature, "converted", detail);
  }
  /** A recorder at the same position that adds `reasons` to the details of their features. */
  within(reasons: ReadonlyMap<Feature, string>): Recorder {
    return new Recorder(
      this.entries,
      new Map([...this.reasons, ...reasons]),
      this.parent,
      this.segment,
    );
  }
  /** The recorder for the child at `segment` of this position. */
  at(segment: LossPathSegment): Recorder {
    return new Recorder(this.entries, this.reasons, this, segment);
  }
}

/** The context for the child at `segment`. */
const at = (ctx: Ctx, segment: LossPathSegment): Ctx => ({ ...ctx, rec: ctx.rec.at(segment) });

/** A 0-based column's letters: 0 is `A`, 25 `Z`, 26 `AA`. */
const columnLetters = (col: number): string => {
  const last = String.fromCodePoint(65 + (col % 26));
  // (`Math` here is the schema's math inline, so the division is spelled out)
  return col < 26 ? last : columnLetters((col - (col % 26)) / 26 - 1) + last;
};

/** A worksheet cell's A1 address, from its 0-based column and row. */
const cellAddress = (col: number, row: number): string => `${columnLetters(col)}${row + 1}`;

interface Ctx {
  readonly allowed: ReadonlySet<Feature>;
  readonly rec: Recorder;
  /** The target profile's structural rules (#126). */
  readonly rules: ReadonlyArray<NotWithin>;
  /** The target profile's `onlyWithin` rules, for features it allows only inside certain nodes (#126). */
  readonly onlyWithin: ReadonlyArray<OnlyWithin>;
  /** The target profile's `fieldValues` rules (#126). */
  readonly fieldValues: ReadonlyArray<FieldValues>;
  /** The target profile's features, to allow an `onlyWithin` feature again inside its node. */
  readonly profile: ReadonlySet<Feature>;
  /** The target profile's `whole` rules (#67). */
  readonly whole: ReadonlyArray<Whole>;
}

/**
 * The context for the contents of a kept node (`node`, of the feature
 * `within`): the features an `onlyWithin` rule allows only inside such a node
 * are allowed again (#126), and the features a `notWithin` rule keeps out of
 * it are no longer allowed there, their loss entries giving the rule's reason
 * (#197).
 */
const inside = (within: Feature, node: RuleNode, ctx: Ctx): Ctx => {
  const admitted = ctx.onlyWithin.filter(
    (r) =>
      r.within === within &&
      ctx.profile.has(r.feature) &&
      !ctx.allowed.has(r.feature) &&
      (r.where === undefined || fieldMatches(node, r.where)),
  );
  const rules = ctx.rules.filter(
    (r) =>
      r.within === within &&
      (ctx.allowed.has(r.feature) || admitted.some((a) => a.feature === r.feature)),
  );
  if (Arr.isReadonlyArrayEmpty(rules) && Arr.isReadonlyArrayEmpty(admitted)) return ctx;
  const excluded = new Set(rules.map((r) => r.feature));
  return {
    ...ctx,
    allowed: new Set(
      [...ctx.allowed, ...admitted.map((r) => r.feature)].filter((f) => !excluded.has(f)),
    ),
    rec: ctx.rec.within(new Map(rules.map((r) => [r.feature, r.reason]))),
  };
};

/**
 * The `fieldValues` rule `node` (of `feature`) breaks, if any: the profile
 * allows the feature, but not with the value one of the node's fields holds.
 */
const brokenFieldRule = (feature: Feature, node: RuleNode, ctx: Ctx): FieldValues | undefined =>
  ctx.fieldValues.find((r) => r.feature === feature && !fieldMatches(node, r));

/** The context for narrowing a node as if the profile lacked `rule.feature`, with the rule's reason. */
const breaking = (rule: FieldValues, ctx: Ctx): Ctx => ({
  ...ctx,
  allowed: new Set([...ctx.allowed].filter((f) => f !== rule.feature)),
  rec: ctx.rec.within(new Map([[rule.feature, rule.reason]])),
});

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

/** A node's attributes narrowed to the target; `node` is its tag, for its id facet (#184). */
const narrowAttr = (
  attr: Attributes | undefined,
  node: IdNode,
  ctx: Ctx,
): Attributes | undefined => {
  if (attr === undefined) return undefined;
  const classes =
    attr.classes !== undefined && Arr.isReadonlyArrayNonEmpty(attr.classes)
      ? attr.classes
      : undefined;
  const data =
    attr.data !== undefined && !Rec.isEmptyReadonlyRecord(attr.data) ? attr.data : undefined;
  // facets in a fixed order, so the loss report lists them id → classes → style → data
  const out: { -readonly [K in keyof Attributes]: Attributes[K] } = {};
  const id = keepFacet(
    attr.id,
    ID_FEATURE[node],
    `format does not support ids on ${node} nodes`,
    ctx,
  );
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
  inlines.flatMap((n, i) => narrowInline(n, at(ctx, i)));

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
  // kept by every profile, except where one of its `notWithin` rules keeps it out of a node (#67)
  SoftBreak: (n, ctx) => {
    if (ctx.allowed.has("inline.softBreak") || !ctx.profile.has("inline.softBreak")) return [n];
    ctx.rec.convert("inline.softBreak", "line break reduced to a space");
    return [new Space({})];
  },
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
    (n, content, ctx) => new Span({ attr: narrowAttr(n.attr, "Span", ctx), content }),
  ),
  Link: wrapper(
    "inline.link",
    "Link reduced to its text",
    (n, content, ctx) =>
      new Link({ attr: narrowAttr(n.attr, "Link", ctx), content, target: n.target }),
  ),
  Image: (n, ctx) => {
    if (ctx.allowed.has("inline.image"))
      return [
        new Image({
          attr: narrowAttr(n.attr, "Image", ctx),
          alt: narrowInlines(n.alt, ctx),
          target: n.target,
        }),
      ];
    // the alt text, then the URL in parentheses, so where the image was is kept (#111)
    const alt = narrowInlines(n.alt, ctx);
    const url = n.target.url === "" ? [] : [new Str({ text: `(${n.target.url})` })];
    ctx.rec.convert("inline.image", "Image reduced to its alt text and URL");
    return Arr.isReadonlyArrayNonEmpty(alt) && Arr.isReadonlyArrayNonEmpty(url)
      ? [...alt, ...narrowInlines([new Space({}), ...url], ctx)]
      : [...alt, ...narrowInlines(url, ctx)];
  },
  Code: textual(
    "inline.code",
    "Code reduced to text",
    (n, ctx) => new Code({ attr: narrowAttr(n.attr, "Code", ctx), text: n.text }),
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

/** The first node of `feature` in `inlines`, depth first. */
const firstOf = (inlines: ReadonlyArray<Inline>, feature: Feature): Inline | undefined =>
  inlines.reduce<Inline | undefined>(
    (found, inline) =>
      found ??
      (TAG_FEATURE[inline._tag] === feature ? inline : firstOf(childInlines(inline), feature)),
    undefined,
  );

/**
 * `runs` (a rich cell's) under the target's `whole` rules (#67): where a rule's
 * feature covers only part of them, they are narrowed as if the profile
 * lacked it (each such node unwrapped, a `converted` loss with the rule's
 * reason), and a `Link` is then put back around all of them, keeping the
 * first link's target and attributes. A feature other than a link has no
 * target to keep, so it stays unwrapped.
 */
const keepWhole = (runs: ReadonlyArray<Inline>, ctx: Ctx): ReadonlyArray<Inline> =>
  ctx.whole
    .filter((rule) => rule.within === "cell.richText" && ctx.allowed.has(rule.feature))
    .reduce((acc, rule) => {
      if (!breaksWhole(acc, rule)) return acc;
      const first = firstOf(acc, rule.feature);
      const content = narrowInlines(acc, {
        ...ctx,
        allowed: new Set([...ctx.allowed].filter((f) => f !== rule.feature)),
        rec: ctx.rec.within(
          new Map([[rule.feature, `${rule.reason}; widened over the whole cell`]]),
        ),
      });
      return Predicate.isTagged(first, "Link")
        ? [new Link({ attr: first.attr, target: first.target, content })]
        : content;
    }, runs);

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
    (c, style, ctx) =>
      new CellRichText({ runs: keepWhole(narrowInlines(c.runs, ctx), ctx), style }),
    (c, style) => new CellText({ value: inlinesToText(c.runs), style }),
  ),
};

/**
 * Whether narrowing keeps a cell exactly as it is: its style stays (it has
 * none, or the profile allows styles) and its type does (a rich-text cell's
 * runs are narrowed too, so it is always rebuilt). Nodes are immutable, so
 * such a cell is returned itself rather than rebuilt.
 */
const keepsCell = (c: SheetCell, ctx: Ctx): boolean => {
  const has = (f: Feature) => ctx.allowed.has(f);
  if (c.style !== undefined && !has("cell.style")) return false;
  return (
    Predicate.isTagged(c, "CellText") ||
    Predicate.isTagged(c, "CellBlank") ||
    (Predicate.isTagged(c, "CellNumber") && has("cell.number")) ||
    (Predicate.isTagged(c, "CellBoolean") && has("cell.boolean")) ||
    (Predicate.isTagged(c, "CellDate") && has("cell.date")) ||
    (Predicate.isTagged(c, "CellError") && has("cell.error")) ||
    (Predicate.isTagged(c, "CellFormula") && has("cell.formula"))
  );
};

const narrowCell = (c: SheetCell, ctx: Ctx): SheetCell => {
  if (keepsCell(c, ctx)) return c;
  let style = c.style;
  if (style !== undefined && !ctx.allowed.has("cell.style")) {
    ctx.rec.drop("cell.style", "cell styling dropped");
    style = undefined;
  }
  return dispatchTag(CELL, c, style, ctx);
};

/**
 * A row position narrowed: a gap as it is, a node narrowed, and a plain cell
 * narrowed as the node it stands for, kept plain when that node is kept.
 */
const narrowPosition = (position: RowCell, ctx: Ctx, col: number, row: number): RowCell => {
  const node = cellOf(position);
  if (node === undefined || keepsCell(node, ctx)) return position;
  // the cell's address only for a cell that is narrowed: the rest cost nothing
  const narrowed = narrowCell(node, at(ctx, cellAddress(col, row)));
  return narrowed === node ? position : narrowed;
};

/** Whether a worksheet row is a `SheetRow` marked hidden. */
const isHiddenRow = (r: WorksheetRow): boolean => !isPlainRow(r) && r.hidden === true;

/**
 * A row with its cells narrowed, and shown when `show` (the target has no
 * `sheet.hidden`): the row itself when nothing changes, and a plain row stays
 * a plain row (#227).
 */
const narrowRow = (r: WorksheetRow, row: number, ctx: Ctx, show: boolean): WorksheetRow => {
  const old = rowCellsOf(r);
  const cells = old.map((c, col) => narrowPosition(c, ctx, col, row));
  const unhide = show && isHiddenRow(r);
  if (!unhide && cells.every((c, i) => c === old[i])) return r;
  return isPlainRow(r)
    ? cells
    : new SheetRow({
        index: r.index,
        cells,
        height: r.height,
        hidden: unhide ? undefined : r.hidden,
      });
};

/**
 * A worksheet's columns narrowed: none without `sheet.columns`, and without
 * their styles (no `cell.style`) or their hidden marks (no `sheet.hidden`),
 * each loss reported once.
 */
const narrowColumns = (
  columns: ReadonlyArray<SheetColumn>,
  ctx: Ctx,
): ReadonlyArray<SheetColumn> => {
  if (Arr.isReadonlyArrayEmpty(columns)) return columns;
  if (!ctx.allowed.has("sheet.columns")) {
    ctx.rec.drop("sheet.columns", "column metadata dropped");
    return [];
  }
  const unstyle = !ctx.allowed.has("cell.style") && columns.some((c) => c.style !== undefined);
  const unhide = !ctx.allowed.has("sheet.hidden") && columns.some((c) => c.hidden === true);
  if (unstyle) ctx.rec.drop("cell.style", "column styling dropped");
  if (unhide) ctx.rec.drop("sheet.hidden", "hidden columns shown");
  if (!unstyle && !unhide) return columns;
  return columns.map((c) =>
    (unstyle && c.style !== undefined) || (unhide && c.hidden === true)
      ? new SheetColumn({
          width: c.width,
          style: unstyle ? undefined : c.style,
          hidden: unhide ? undefined : c.hidden,
        })
      : c,
  );
};

// ---- comments (#67) -------------------------------------------------------

/** "Author: text" for a reply's paragraph (just the text when the reply has no author). */
const replyText = (reply: Comment): string => {
  const text = blocksToText(reply.content);
  return reply.author === undefined ? text : `${reply.author}: ${text}`;
};

/** A comment's replies, replies of replies after them, in thread order (depth first). */
const flattenReplies = (comment: Comment): ReadonlyArray<Comment> =>
  comment.replies.flatMap((reply) => [reply, ...flattenReplies(reply)]);

/**
 * A comment with its thread folded into it: each reply (and the replies to
 * those) a paragraph "Author: text" after its body, and no resolved mark,
 * for a target that has comments but not threads. A comment that is no thread
 * is returned as it is.
 */
const foldThread = (comment: Comment, ctx: Ctx): Comment => {
  if (comment.resolved === undefined && Arr.isReadonlyArrayEmpty(comment.replies)) return comment;
  const replies = flattenReplies(comment);
  ctx.rec.convert(
    "review.threads",
    Arr.isReadonlyArrayEmpty(replies)
      ? "resolved mark dropped"
      : `${replies.length} repl${replies.length === 1 ? "y" : "ies"} folded into the comment${comment.resolved === undefined ? "" : ", resolved mark dropped"}`,
  );
  return new Comment({
    author: comment.author,
    initials: comment.initials,
    date: comment.date,
    content: [
      ...comment.content,
      ...replies.map((reply) => new Para({ content: [new Str({ text: replyText(reply) })] })),
    ],
    replies: [],
  });
};

/**
 * A comment kept by a target with comments: its thread folded unless the
 * target has threads, its body narrowed as blocks inside a comment (the
 * features a profile allows only there are allowed again), and its replies
 * narrowed likewise.
 */
const narrowComment = (comment: Comment, ctx: Ctx, reply = false): Comment => {
  const folded = ctx.allowed.has("review.threads") ? comment : foldThread(comment, ctx);
  // a comment of a thread (the root, or a reply) is also inside `review.threads`,
  // where a profile may keep less than in a note (XLSX: plain text only)
  const inComment = inside("review.comments", folded, ctx);
  const within =
    ctx.allowed.has("review.threads") && (reply || isThreadComment(folded))
      ? inside("review.threads", folded, inComment)
      : inComment;
  return new Comment({
    author: folded.author,
    initials: folded.initials,
    date: folded.date,
    resolved: folded.resolved,
    content: narrowBlocks(folded.content, at(within, "content")),
    replies: folded.replies.map((answer, i) =>
      narrowComment(answer, at(at(ctx, "replies"), i), true),
    ),
  });
};

/**
 * A worksheet's comments narrowed: without `review.comments` each is dropped,
 * reported at its cell's address; with it, each is kept, narrowed, and the
 * list is the sheet's own when nothing changed.
 */
const narrowComments = (
  comments: ReadonlyArray<CellComment>,
  ctx: Ctx,
): ReadonlyArray<CellComment> => {
  if (!ctx.allowed.has("review.comments")) {
    comments.forEach((c) => {
      at(ctx, cellAddress(c.col, c.row)).rec.drop("review.comments", "comment dropped");
    });
    return [];
  }
  return comments.map((c) => {
    const comment = narrowComment(c.comment, at(ctx, cellAddress(c.col, c.row)));
    return new CellComment({ row: c.row, col: c.col, comment });
  });
};

const narrowWorksheet = (w: Worksheet, ctx: Ctx): Worksheet => {
  const has = (f: Feature) => ctx.allowed.has(f);
  let merges = w.merges;
  if (Arr.isReadonlyArrayNonEmpty(merges) && !has("sheet.merges")) {
    ctx.rec.drop("sheet.merges", "merged ranges dropped");
    merges = [];
  }
  const show = !has("sheet.hidden");
  let visibility = w.visibility;
  if (visibility !== undefined && show) {
    ctx.rec.drop("sheet.hidden", `hidden worksheet "${w.name}" shown`);
    visibility = undefined;
  }
  const columns = narrowColumns(w.columns, ctx);
  if (show && w.rows.some(isHiddenRow)) ctx.rec.drop("sheet.hidden", "hidden rows shown");
  const indexes = rowIndexes(w);
  const rows = w.rows.map((r, i) => narrowRow(r, indexes[i] ?? i, ctx, show));
  const comments = w.comments === undefined ? undefined : narrowComments(w.comments, ctx);
  // nothing narrowed: the worksheet itself (nodes are immutable)
  if (
    w.attr === undefined &&
    visibility === w.visibility &&
    columns === w.columns &&
    merges === w.merges &&
    w.comments === undefined &&
    rows.every((r, i) => r === w.rows[i])
  )
    return w;
  return new Worksheet({
    attr: narrowAttr(w.attr, "Worksheet", ctx),
    name: w.name,
    columns,
    rows,
    merges,
    visibility,
    comments: comments === undefined || Arr.isReadonlyArrayEmpty(comments) ? undefined : comments,
  });
};

/**
 * A worksheet's comments as the notes a prose table keeps them in (#67): for
 * each commented cell of `grid`, a `Note` after the cell's text holding the
 * comments' blocks, each reply a paragraph "Author: text", keyed by
 * `"row,col"`. Each comment is reported `converted`; one on a cell outside the
 * grid (a blank cell past the rows the sheet holds) has no table cell and is
 * reported `dropped`.
 */
const noteComments = (
  w: Worksheet,
  grid: ReadonlyArray<ReadonlyArray<SheetCell>>,
  ctx: Ctx,
): Readonly<Record<string, ReadonlyArray<readonly [key: string, note: Note]>>> =>
  Arr.groupBy(
    (w.comments ?? []).flatMap((c) => {
      const here = at(ctx, cellAddress(c.col, c.row));
      if (grid[c.row]?.[c.col] === undefined) {
        here.rec.drop("review.comments", "comment on a cell outside the table dropped");
        return [];
      }
      const replies = flattenReplies(c.comment).map(
        (reply) => new Para({ content: [new Str({ text: replyText(reply) })] }),
      );
      here.rec.convert("review.comments", "comment converted to a note in the table cell");
      return [
        [`${c.row},${c.col}`, new Note({ content: [...c.comment.content, ...replies] })] as const,
      ];
    }),
    ([key]) => key,
  );

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
  const noted = noteComments(w, grid.success, ctx);
  const rows = grid.success.map(
    (row, r) =>
      new TableRow({
        cells: row.map(
          (c, col) =>
            new TableCell({
              content: [
                new Plain({
                  content: [
                    new Str({ text: cellToText(c) }),
                    ...(noted[`${r},${col}`] ?? []).map(([, note]) => note),
                  ],
                }),
              ],
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

/** A prose table row's cells as text cells. */
const rowToCells = (row: TableRow): SheetCell[] =>
  row.cells.map((c) => new CellText({ value: blocksToText(c.content) }));

const tableToWorksheet = (t: Table, ctx: Ctx): Block[] => {
  const rows = [...t.head, ...t.body, ...t.foot].map((r, index) => sheetRow(index, rowToCells(r)));
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
    const broken = ctx.allowed.has(feature) ? brokenFieldRule(feature, s, ctx) : undefined;
    if (ctx.allowed.has(feature) && broken === undefined)
      return [rebuild(s, inside(feature, s, ctx))];
    (broken === undefined ? ctx : breaking(broken, ctx)).rec.drop(feature, detail);
    return [];
  };

const SHAPE: TagHandlers<Shape, [Ctx], Shape[]> = {
  TextBox: shape(
    "shape.textBox",
    "text box dropped",
    (s, ctx) =>
      new TextBox({
        attr: narrowAttr(s.attr, "TextBox", ctx),
        content: narrowBlocks(s.content, ctx),
      }),
  ),
  Picture: shape(
    "shape.picture",
    "picture dropped",
    (s, ctx) => new Picture({ attr: narrowAttr(s.attr, "Picture", ctx), src: s.src, alt: s.alt }),
  ),
  TableShape: shape(
    "shape.table",
    "table shape dropped",
    (s, ctx) =>
      new TableShape({
        attr: narrowAttr(s.attr, "TableShape", ctx),
        table: narrowTable(s.table, ctx),
      }),
  ),
  Placeholder: shape(
    "shape.placeholder",
    "placeholder dropped",
    (s, ctx) =>
      new Placeholder({
        attr: narrowAttr(s.attr, "Placeholder", ctx),
        placeholderType: s.placeholderType,
        idx: s.idx,
        content: narrowBlocks(s.content, ctx),
      }),
  ),
};

const narrowShape = (s: Shape, ctx: Ctx): Shape[] => dispatchTag(SHAPE, s, ctx);

const narrowSlideShow = (d: SlideShow, ctx: Ctx): SlideShow => {
  const slides = d.slides.map((sl, n) => {
    const here = at(ctx, n);
    let notes = sl.notes;
    if (notes !== undefined && !here.allowed.has("deck.notes")) {
      at(here, "notes").rec.drop("deck.notes", "speaker notes dropped");
      notes = undefined;
    }
    return new Slide({
      attr: narrowAttr(sl.attr, "Slide", here),
      layout: sl.layout,
      shapes: sl.shapes.flatMap((sh, k) => narrowShape(sh, at(here, k))),
      notes: notes === undefined ? undefined : narrowBlocks(notes, at(here, "notes")),
    });
  });
  return new SlideShow({ attr: narrowAttr(d.attr, "SlideShow", ctx), size: d.size, slides });
};

// ---- prose table ----------------------------------------------------------

const narrowTableRow = (r: TableRow, ctx: Ctx): TableRow =>
  new TableRow({
    cells: r.cells.map((c, k) => narrowTableCell(c, at(ctx, k))),
  });

const narrowTableCell = (c: TableCell, ctx: Ctx): TableCell =>
  new TableCell({
    attr: narrowAttr(c.attr, "TableCell", ctx),
    align: c.align,
    rowSpan: c.rowSpan,
    colSpan: c.colSpan,
    content: narrowBlocks(c.content, ctx),
  });

const narrowTable = (t: Table, ctx: Ctx): Table =>
  new Table({
    attr: narrowAttr(t.attr, "Table", ctx),
    caption: t.caption === undefined ? undefined : narrowInlines(t.caption, at(ctx, "caption")),
    colSpecs: t.colSpecs,
    head: t.head.map((r, i) => narrowTableRow(r, at(at(ctx, "head"), i))),
    body: t.body.map((r, i) => narrowTableRow(r, at(at(ctx, "body"), i))),
    foot: t.foot.map((r, i) => narrowTableRow(r, at(at(ctx, "foot"), i))),
  });

// ---- blocks ---------------------------------------------------------------

const blockFeature = (tag: Block["_tag"]): Feature => TAG_FEATURE[tag];

const narrowBlocks = (blocks: ReadonlyArray<Block>, ctx: Ctx): Block[] =>
  blocks.flatMap((b, i) => narrowBlock(b, at(ctx, i)));

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
    const rows = [...b.head, ...b.body, ...b.foot].map((r) =>
      r.cells.map((c) => blocksToText(c.content)),
    );
    ctx.rec.convert(
      feature,
      `table converted to ${rows.length} paragraph(s), one per row, cells tab-separated`,
    );
    return rowParagraphs(rows, ctx);
  },
  Worksheet: (b, feature, ctx) => {
    if (ctx.allowed.has("block.table")) return worksheetToTable(b, ctx);
    const grid = denseRows(b);
    if (Result.isFailure(grid)) {
      ctx.rec.drop(
        feature,
        `worksheet "${b.name}" dropped: ${grid.failure.message}, too large to lay out as paragraphs`,
      );
      return [];
    }
    const rows = grid.success.map((row) => row.map(cellToText));
    (b.comments ?? []).forEach((c) => {
      at(ctx, cellAddress(c.col, c.row)).rec.drop(
        "review.comments",
        "comment dropped: the worksheet became paragraphs",
      );
    });
    ctx.rec.convert(
      feature,
      `worksheet "${b.name}" converted to ${rows.length} paragraph(s), one per row, cells tab-separated`,
    );
    return rowParagraphs(rows, ctx);
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
    ctx.rec.convert(feature, "horizontal rule converted to a *** paragraph");
    return narrowBlock(new Para({ content: [new Str({ text: "***" })] }), ctx);
  },
};

/**
 * A grid's rows as paragraphs (#111), for a target with neither tables nor
 * worksheets: one per row, its cells' text joined by tabs, so the data stays
 * readable (and splittable) instead of being dropped. Re-narrowed, so a target
 * without paragraphs gets what it has.
 */
const rowParagraphs = (rows: ReadonlyArray<ReadonlyArray<string>>, ctx: Ctx): Block[] =>
  rows.flatMap((cells, index) =>
    narrowBlock(new Para({ content: [new Str({ text: cells.join("\t") })] }), at(ctx, index)),
  );

/** Narrow the contents of a block the profile has. */
const KEEP: TagHandlers<Block, [Ctx], Block[]> = {
  Plain: (b, ctx) => [new Plain({ content: narrowInlines(b.content, ctx) })],
  Para: (b, ctx) => [new Para({ content: narrowInlines(b.content, ctx) })],
  Header: (b, ctx) => [
    new Header({
      level: b.level,
      attr: narrowAttr(b.attr, "Header", ctx),
      content: narrowInlines(b.content, ctx),
    }),
  ],
  BlockQuote: (b, ctx) => [new BlockQuote({ content: narrowBlocks(b.content, ctx) })],
  Div: (b, ctx) => [
    new Div({ attr: narrowAttr(b.attr, "Div", ctx), content: narrowBlocks(b.content, ctx) }),
  ],
  Figure: (b, ctx) => [
    new Figure({
      attr: narrowAttr(b.attr, "Figure", ctx),
      caption: narrowBlocks(b.caption, ctx),
      content: narrowBlocks(b.content, ctx),
    }),
  ],
  OrderedList: (b, ctx) => [
    new OrderedList({
      attr: narrowAttr(b.attr, "OrderedList", ctx),
      start: b.start,
      numberStyle: b.numberStyle,
      numberDelim: b.numberDelim,
      items: b.items.map((it, k) => narrowBlocks(it, at(ctx, k))),
    }),
  ],
  BulletList: (b, ctx) => [
    new BulletList({
      attr: narrowAttr(b.attr, "BulletList", ctx),
      items: b.items.map((it, k) => narrowBlocks(it, at(ctx, k))),
    }),
  ],
  Table: (b, ctx) => [narrowTable(b, ctx)],
  Worksheet: (b, ctx) => [narrowWorksheet(b, ctx)],
  SlideShow: (b, ctx) => [narrowSlideShow(b, ctx)],
  DefinitionList: (b, ctx) => [
    new DefinitionList({
      attr: narrowAttr(b.attr, "DefinitionList", ctx),
      items: b.items.map(
        (item, k) =>
          new DefinitionItem({
            term: narrowInlines(item.term, at(at(ctx, k), "term")),
            definitions: item.definitions.map((d, j) => narrowBlocks(d, at(at(ctx, k), j))),
          }),
      ),
    }),
  ],
  LineBlock: (b, ctx) => [
    new LineBlock({ lines: b.lines.map((l, k) => narrowInlines(l, at(ctx, k))) }),
  ],
  CodeBlock: (b, ctx) => [
    new CodeBlock({
      attr: narrowAttr(b.attr, "CodeBlock", ctx),
      text: b.text,
      language: b.language,
    }),
  ],
  // no inline content or attributes to narrow
  RawBlock: (b) => [b],
  HorizontalRule: (b) => [b],
};

const narrowBlock = (b: Block, ctx: Ctx): Block[] => {
  const feature = blockFeature(b._tag);
  if (!ctx.allowed.has(feature)) return dispatchTag(FALLBACK, b, feature, ctx);
  const broken = brokenFieldRule(feature, b, ctx);
  return broken === undefined
    ? dispatchTag(KEEP, b, inside(feature, b, ctx))
    : dispatchTag(FALLBACK, b, feature, breaking(broken, ctx));
};

/**
 * Narrow a document so it conforms to `to`, recording everything that had to be
 * dropped or down-converted.
 */
export const narrow = <To extends Feature>(doc: Document, to: Profile<To>): NarrowResult<To> => {
  // a feature an `onlyWithin` rule admits only inside certain nodes starts
  // out disallowed; `inside` allows it again within such a node (#126)
  const confined = to.onlyWithin.filter((r) => to.features.has(r.feature));
  const ctx: Ctx = {
    allowed: Arr.isReadonlyArrayEmpty(confined)
      ? to.features
      : new Set([...to.features].filter((f) => !confined.some((r) => r.feature === f))),
    rec: new Recorder(undefined, new Map(confined.map((r) => [r.feature, r.reason]))),
    rules: to.notWithin,
    onlyWithin: to.onlyWithin,
    fieldValues: to.fieldValues,
    profile: to.features,
    whole: to.whole,
  };
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
  const resources = narrowResources(doc, ctx);
  // `narrowBlocks` rebuilt every node through the `ctx.allowed` check, so the
  // tree uses only the target profile's features.
  const document = trustAs<To>(
    Option.match(resources, {
      onNone: () => new Document({ meta: doc.meta, blocks: narrowed }),
      onSome: (kept) => new Document({ meta: doc.meta, blocks: narrowed, resources: kept }),
    }),
  );
  return {
    document,
    loss: lossReport(ctx.rec.entries),
  };
};

/**
 * The media bag the target keeps (#113): `doc`'s when it allows
 * `doc.resources`, otherwise none, each resource reported at the path
 * `["resources", id]`. The `resource:` URLs that referred to them are left as
 * they are, so a caller that wants the files (Pandoc's `--extract-media`)
 * takes `doc.resources` before narrowing.
 */
const narrowResources = (doc: Document, ctx: Ctx): Option.Option<Resources> => {
  const resources = doc.resources;
  if (resources === undefined || Rec.isEmptyRecord(resources)) return Option.none();
  if (ctx.allowed.has("doc.resources")) return Option.some(resources);
  const rec = ctx.rec.at("resources");
  Rec.toEntries(resources).forEach(([id, r]) =>
    rec
      .at(id)
      .drop(
        "doc.resources",
        `embedded ${r.mediaType} (${r.bytes.length} bytes); references to ${resourceUrl(id)} are left dangling`,
      ),
  );
  return Option.none();
};

/** Narrow within an Effect. */
export const narrowEffect = <To extends Feature>(
  doc: Document,
  to: Profile<To>,
): Effect.Effect<NarrowResult<To>> => Effect.sync(() => narrow(doc, to));
