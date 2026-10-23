/**
 * The DOCX Reader: .docx bytes -> a prose document in the DOCX profile.
 *
 * Parses `word/document.xml`: paragraphs (headings via `w:pStyle`, list items
 * via `w:numPr`, their kind and nesting from `word/numbering.xml` and
 * `w:ilvl`), runs (bold/italic/underline/strike/super/sub/small-caps, with
 * OOXML's explicit "off" toggle values), hyperlinks (external through the
 * document relationships, internal `w:anchor`s as `#anchor`), simple and
 * complex fields (a HYPERLINK field becomes a link), tables, and the content
 * of tracked insertions and content controls. Tracked deletions are dropped,
 * and a page break ends the paragraph.
 */

import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as HashMap from "effect/HashMap";
import * as HashSet from "effect/HashSet";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import {
  type Block,
  BulletList,
  CodeBlock,
  type Content,
  contentToBytes,
  DEFAULT_MAX_NESTING_DEPTH,
  type Doc,
  document,
  Emph,
  Header,
  type Inline,
  inlinesToText,
  LineBreak,
  limitNestingDepth,
  Link,
  makeReaderTag,
  OrderedList,
  Para,
  ParseError,
  Plain,
  type Reader,
  SmallCaps,
  Str,
  Strikeout,
  Strong,
  Subscript,
  Superscript,
  Table,
  TableCell,
  TableRow,
  trustAs,
  Underline,
} from "@thomasfosterau/effect-document";
import {
  OpcError,
  type OpcLimits,
  OpcReader,
  type XmlElement,
  findChild,
  findChildren,
  getAttr,
  ooxmlParseError,
} from "../shared/index.ts";
import { Docx, type DocxFeature } from "./profile.ts";

/** Options for the DOCX reader: zip resource limits and the nesting-depth limit. */
export interface DocxReaderOptions {
  /** Zip-bomb limits (entry count, entry size, total size); see `OpcLimits`. */
  readonly limits?: OpcLimits | undefined;
  /**
   * The deepest nesting (e.g. tables inside tables) the reader accepts before
   * failing with a `"LimitExceeded"` ParseError. Defaults to
   * `DEFAULT_MAX_NESTING_DEPTH` (128).
   */
  readonly maxDepth?: number | undefined;
}

/** Main-part content types this reader accepts. */
const MAIN_CONTENT_TYPES = [
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml",
  "application/vnd.ms-word.document.macroEnabled.main+xml",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.template.main+xml",
  "application/vnd.ms-word.template.macroEnabledTemplate.main+xml",
];

interface Fmt {
  b: boolean;
  i: boolean;
  u: boolean;
  strike: boolean;
  vert: "superscript" | "subscript" | null;
  caps: boolean;
}

const wrap = (node: Inline, f: Fmt): Inline => {
  let x = node;
  if (f.caps) x = new SmallCaps({ content: [x] });
  if (f.vert === "superscript") x = new Superscript({ content: [x] });
  if (f.vert === "subscript") x = new Subscript({ content: [x] });
  if (f.i) x = new Emph({ content: [x] });
  if (f.b) x = new Strong({ content: [x] });
  if (f.u) x = new Underline({ content: [x] });
  if (f.strike) x = new Strikeout({ content: [x] });
  return x;
};

/** ST_OnOff's explicit "off" values; a toggle with no `w:val` is on. */
const OFF = new Set(["0", "false", "off"]);

const readFmt = (r: XmlElement): Fmt => {
  const rPr = findChild(r, "rPr");
  const has = (name: string): boolean => {
    if (rPr === undefined) return false;
    const el = findChild(rPr, name);
    if (el === undefined) return false;
    const val = getAttr(el, "val");
    return val === undefined || !OFF.has(val);
  };
  const uEl = rPr === undefined ? undefined : findChild(rPr, "u");
  const uVal = uEl === undefined ? undefined : getAttr(uEl, "val");
  const vertEl = rPr === undefined ? undefined : findChild(rPr, "vertAlign");
  const vertVal = vertEl === undefined ? undefined : getAttr(vertEl, "val");
  return {
    b: has("b"),
    i: has("i"),
    u: uEl !== undefined && uVal !== "none",
    strike: has("strike"),
    caps: has("smallCaps"),
    vert: vertVal === "superscript" ? "superscript" : vertVal === "subscript" ? "subscript" : null,
  };
};

// ============================================================================
// Inline content
// ============================================================================

/** Marks a page break inside a paragraph's inlines; the paragraph splits there. */
const PAGE_BREAK: unique symbol = Symbol("pageBreak");
type Piece = Inline | typeof PAGE_BREAK;

interface Field {
  instr: string;
  phase: "instr" | "result";
  readonly result: Piece[];
}

/** `HYPERLINK "url"` or `HYPERLINK \l "anchor"` as a link target, else null. */
const hyperlinkField = (instr: string): string | null => {
  const m = instr.trim().match(/^HYPERLINK\b(.*)$/i);
  if (m === null) return null;
  const args = m[1]!;
  const anchor = args.match(/\\l\s+"([^"]*)"/);
  if (anchor !== null) return `#${anchor[1]}`;
  const url = args.match(/^\s*"([^"]*)"/) ?? args.match(/^\s*(\S+)/);
  return url === null ? null : url[1]!;
};

/** Run children that stand for a fixed character. */
const RUN_TEXT = HashMap.make(["tab", "\t"], ["noBreakHyphen", "\u2011"], ["softHyphen", "\u00ad"]);

/** Wrappers whose runs are visible text: tracked insertions and moves, smart tags, custom XML. */
const TRANSPARENT_WRAPPERS = HashSet.make("ins", "moveTo", "smartTag", "customXml");

/**
 * Collects a paragraph's inlines, threading complex-field state
 * (`w:fldChar` begin/separate/end, `w:instrText`) across runs: a field's
 * instruction text is dropped and its result kept, as a link for HYPERLINK.
 */
class InlineCollector {
  readonly out: Piece[] = [];
  private readonly fields: Field[] = [];

  private readonly rels: ReadonlyMap<string, string>;

  constructor(rels: ReadonlyMap<string, string>) {
    this.rels = rels;
  }

  push(piece: Piece): void {
    const field = this.fields[this.fields.length - 1];
    if (field === undefined) this.out.push(piece);
    else if (field.phase === "result") field.result.push(piece);
  }

  private emitField(field: Field): void {
    const url = hyperlinkField(field.instr);
    const inlines = field.result.filter((x): x is Inline => x !== PAGE_BREAK);
    if (url !== null) this.push(new Link({ content: inlines, target: { url } }));
    else for (const x of field.result) this.push(x);
  }

  /** Close any field left open at the end of the paragraph. */
  finish(): Piece[] {
    while (Arr.isReadonlyArrayNonEmpty(this.fields)) this.emitField(this.fields.pop()!);
    return this.out;
  }

  run(r: XmlElement): void {
    const f = readFmt(r);
    for (const child of r.children) this.runChild(child, f);
  }

  private runChild(child: XmlElement, f: Fmt): void {
    const text = child.name === "t" ? Option.some(child.text) : HashMap.get(RUN_TEXT, child.name);
    if (Option.isSome(text)) this.push(wrap(new Str({ text: text.value }), f));
    else if (child.name === "br")
      this.push(getAttr(child, "type") === "page" ? PAGE_BREAK : new LineBreak());
    else if (child.name === "cr") this.push(new LineBreak());
    else if (child.name === "instrText") this.instrText(child.text);
    else if (child.name === "fldChar") this.fldChar(getAttr(child, "fldCharType"));
  }

  private instrText(text: string): void {
    const field = this.fields[this.fields.length - 1];
    if (field !== undefined && field.phase === "instr") field.instr += text;
  }

  private fldChar(type: string | undefined): void {
    if (type === "begin") this.fields.push({ instr: "", phase: "instr", result: [] });
    else if (type === "separate") {
      const field = this.fields[this.fields.length - 1];
      if (field !== undefined) field.phase = "result";
    } else if (type === "end") {
      const field = this.fields.pop();
      if (field !== undefined) this.emitField(field);
    }
  }

  /** Paragraph-level content: runs and the containers that wrap them. */
  content(parent: XmlElement): void {
    for (const child of parent.children) this.contentChild(child);
  }

  private contentChild(child: XmlElement): void {
    if (child.name === "r") this.run(child);
    // Tracked insertions, moves and wrappers whose runs are visible text.
    else if (HashSet.has(TRANSPARENT_WRAPPERS, child.name)) this.content(child);
    else if (child.name === "sdt") {
      const sdtContent = findChild(child, "sdtContent");
      if (sdtContent !== undefined) this.content(sdtContent);
    } else if (child.name === "hyperlink") this.hyperlink(child);
    else if (child.name === "fldSimple") this.fldSimple(child);
    // w:del, w:moveFrom (deleted text), w:pPr, bookmarks, proofing marks: skipped.
  }

  /** The inlines inside `el`, collected on their own (fields do not cross it). */
  private inner(el: XmlElement): Piece[] {
    const inner = new InlineCollector(this.rels);
    inner.content(el);
    return inner.finish();
  }

  private hyperlink(el: XmlElement): void {
    const id = getAttr(el, "id");
    const anchor = getAttr(el, "anchor");
    const url =
      id !== undefined ? (this.rels.get(id) ?? "") : anchor !== undefined ? `#${anchor}` : "";
    const content = this.inner(el).filter((x): x is Inline => x !== PAGE_BREAK);
    this.push(new Link({ content, target: { url } }));
  }

  private fldSimple(el: XmlElement): void {
    const result = this.inner(el);
    const url = hyperlinkField(getAttr(el, "instr") ?? "");
    if (url === null) {
      for (const x of result) this.push(x);
      return;
    }
    const content = result.filter((x): x is Inline => x !== PAGE_BREAK);
    this.push(new Link({ content, target: { url } }));
  }
}

/** A paragraph's inlines, split into segments at page breaks. */
const paragraphSegments = (p: XmlElement, rels: ReadonlyMap<string, string>): Inline[][] => {
  const collector = new InlineCollector(rels);
  collector.content(p);
  const segments: Inline[][] = [[]];
  for (const piece of collector.finish()) {
    if (piece === PAGE_BREAK) segments.push([]);
    else segments[segments.length - 1]!.push(piece);
  }
  const nonEmpty = segments.filter((s) => Arr.isReadonlyArrayNonEmpty(s));
  return Arr.isReadonlyArrayNonEmpty(nonEmpty) ? nonEmpty : [[]];
};

const paragraphInlines = (p: XmlElement, rels: ReadonlyMap<string, string>): Inline[] =>
  paragraphSegments(p, rels).flat();

// ============================================================================
// Numbering
// ============================================================================

/** List kind and start number per (numId, ilvl), from `word/numbering.xml`. */
interface Numbering {
  readonly kind: (numId: string, ilvl: number) => "bullet" | "ordered";
  readonly start: (numId: string, ilvl: number) => number;
}

const intAttr = (el: XmlElement | undefined, name: string): number | undefined => {
  const v = el === undefined ? undefined : getAttr(el, name);
  const n = v === undefined ? Number.NaN : Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : undefined;
};

const parseNumbering = (root: XmlElement | null): Numbering => {
  const abstractFormats = new Map<string, Map<number, { fmt: string; start: number }>>();
  const nums = new Map<string, { abstractId: string; starts: Map<number, number> }>();
  if (root !== null) {
    for (const abs of findChildren(root, "abstractNum")) {
      const levels = new Map<number, { fmt: string; start: number }>();
      for (const lvl of findChildren(abs, "lvl")) {
        const numFmt = findChild(lvl, "numFmt");
        levels.set(intAttr(lvl, "ilvl") ?? 0, {
          fmt: numFmt === undefined ? "" : (getAttr(numFmt, "val") ?? ""),
          start: intAttr(findChild(lvl, "start"), "val") ?? 1,
        });
      }
      abstractFormats.set(getAttr(abs, "abstractNumId") ?? "", levels);
    }
    for (const num of findChildren(root, "num")) {
      const abs = findChild(num, "abstractNumId");
      const starts = new Map<number, number>();
      for (const o of findChildren(num, "lvlOverride")) {
        const start = intAttr(findChild(o, "startOverride"), "val");
        if (start !== undefined) starts.set(intAttr(o, "ilvl") ?? 0, start);
      }
      nums.set(getAttr(num, "numId") ?? "", {
        abstractId: abs === undefined ? "" : (getAttr(abs, "val") ?? ""),
        starts,
      });
    }
  }
  const level = (numId: string, ilvl: number) =>
    abstractFormats.get(nums.get(numId)?.abstractId ?? "")?.get(ilvl);
  return {
    start: (numId, ilvl) => nums.get(numId)?.starts.get(ilvl) ?? level(numId, ilvl)?.start ?? 1,
    kind: (numId, ilvl) => {
      const fmt = level(numId, ilvl)?.fmt;
      if (fmt !== undefined) return fmt === "bullet" || fmt === "none" ? "bullet" : "ordered";
      // Without a numbering part, fall back to this writer's old convention
      // (numId 1 = bullets, 2 = numbered); an unknown definition is a bullet.
      return root === null && numId === "2" ? "ordered" : "bullet";
    },
  };
};

// ============================================================================
// Blocks
// ============================================================================

interface Ctx {
  readonly rels: ReadonlyMap<string, string>;
  readonly numbering: Numbering;
}

const paragraphStyle = (p: XmlElement): string | undefined => {
  const pPr = findChild(p, "pPr");
  if (pPr === undefined) return undefined;
  const pStyle = findChild(pPr, "pStyle");
  return pStyle === undefined ? undefined : getAttr(pStyle, "val");
};

/** A paragraph's list membership; `numId="0"` explicitly means "not a list". */
const listInfo = (p: XmlElement): { numId: string; ilvl: number } | null => {
  const pPr = findChild(p, "pPr");
  if (pPr === undefined) return null;
  const numPr = findChild(pPr, "numPr");
  if (numPr === undefined) return null;
  const numIdEl = findChild(numPr, "numId");
  const numId = numIdEl === undefined ? "1" : (getAttr(numIdEl, "val") ?? "1");
  if (numId === "0") return null;
  const ilvlEl = findChild(numPr, "ilvl");
  const ilvl = Number.parseInt(ilvlEl === undefined ? "0" : (getAttr(ilvlEl, "val") ?? "0"), 10);
  return { numId, ilvl: Number.isFinite(ilvl) ? Math.min(Math.max(ilvl, 0), 8) : 0 };
};

const paragraphToBlocks = (p: XmlElement, ctx: Ctx): Block[] => {
  const style = paragraphStyle(p);
  const segments = paragraphSegments(p, ctx.rels);
  if (style === "Code") {
    return [new CodeBlock({ text: inlinesToText(segments.flat()) })];
  }
  const heading = style?.match(/^Heading([1-6])$/);
  return segments.map((inlines, n) =>
    heading && n === 0
      ? new Header({ level: Number.parseInt(heading[1]!, 10), content: inlines })
      : new Para({ content: inlines }),
  );
};

/** A list paragraph as its item's lead block: a `Header` in a heading style, else a `Plain`. */
const listItemBlock = (p: XmlElement, ctx: Ctx): Block => {
  const heading = paragraphStyle(p)?.match(/^Heading([1-6])$/);
  const content = paragraphInlines(p, ctx.rels);
  return heading
    ? new Header({ level: Number.parseInt(heading[1] ?? "1", 10), content })
    : new Plain({ content });
};

/** Thrown when tables nest deeper than the reader's `maxDepth`. */
class NestingLimit extends Error {}

/**
 * The deepest chain of nested `w:tbl` elements under `el`, counted with an
 * explicit stack: the recursive conversion below would exhaust Node's call
 * stack on a document nested far past `maxDepth` before it could refuse it.
 */
const tableNesting = (el: XmlElement): number => {
  let deepest = 0;
  const stack: Array<readonly [XmlElement, number]> = [[el, 0]];
  for (let next = stack.pop(); next !== undefined; next = stack.pop()) {
    const [node, outer] = next;
    const tables = node.name === "tbl" ? outer + 1 : outer;
    deepest = Math.max(deepest, tables);
    for (const child of node.children) stack.push([child, tables]);
  }
  return deepest;
};

/** The current block depth and the limit, threaded through nested tables. */
interface Depth {
  readonly level: number;
  readonly max: number;
}

/** A table's rows, including those wrapped in row-level content controls. */
const tableRows = (tbl: XmlElement): XmlElement[] =>
  tbl.children.flatMap((c) =>
    c.name === "tr" ? [c] : c.name === "sdt" ? tableRows(findChild(c, "sdtContent") ?? c) : [],
  );

/** A row's cells, including those wrapped in cell-level content controls. */
const rowCells = (tr: XmlElement): XmlElement[] =>
  tr.children.flatMap((c) =>
    c.name === "tc" ? [c] : c.name === "sdt" ? rowCells(findChild(c, "sdtContent") ?? c) : [],
  );

const tableToBlock = (tbl: XmlElement, ctx: Ctx, depth: Depth): Table => {
  if (depth.level > depth.max) throw new NestingLimit();
  const inner: Depth = { level: depth.level + 1, max: depth.max };
  const head: TableRow[] = [];
  const body: TableRow[] = [];
  for (const tr of tableRows(tbl)) {
    const trPr = findChild(tr, "trPr");
    const isHeader = trPr !== undefined && findChild(trPr, "tblHeader") !== undefined;
    // a loop rather than `map`, to spend two fewer stack frames per nesting level
    const cells: TableCell[] = [];
    for (const tc of rowCells(tr))
      cells.push(new TableCell({ content: bodyToBlocks(tc, ctx, inner) }));
    (isHeader ? head : body).push(new TableRow({ cells }));
  }
  return new Table({ colSpecs: [], head, body, foot: [] });
};

interface OpenList {
  readonly kind: "bullet" | "ordered";
  readonly numId: string;
  readonly level: number;
  readonly start: number;
  readonly items: Block[][];
}

const listBlock = (l: OpenList): Block =>
  l.kind === "ordered"
    ? new OrderedList({ start: l.start === 1 ? undefined : l.start, items: l.items })
    : new BulletList({ items: l.items });

/**
 * Convert an element's `w:p`/`w:tbl` children (and those of block-level
 * content controls) into blocks, grouping list items into lists nested by
 * `w:ilvl`.
 */
const bodyToBlocks = (parent: XmlElement, ctx: Ctx, depth: Depth): Block[] => {
  const out: Block[] = [];
  // The open lists, outermost first; a deeper ilvl nests inside the last item.
  const open: OpenList[] = [];

  const close = (): void => {
    const list = open.pop()!;
    const outer = open[open.length - 1];
    if (outer === undefined) out.push(listBlock(list));
    else if (Arr.isReadonlyArrayEmpty(outer.items)) outer.items.push([listBlock(list)]);
    else outer.items[outer.items.length - 1]!.push(listBlock(list));
  };
  const closeAll = (): void => {
    while (Arr.isReadonlyArrayNonEmpty(open)) close();
  };

  const visit = (el: XmlElement): void => {
    for (const child of el.children) {
      if (child.name === "p") {
        const li = listInfo(child);
        if (li === null) {
          closeAll();
          out.push(...paragraphToBlocks(child, ctx));
          continue;
        }
        const kind = ctx.numbering.kind(li.numId, li.ilvl);
        while (Arr.isReadonlyArrayNonEmpty(open) && open[open.length - 1]!.level > li.ilvl) close();
        const top = open[open.length - 1];
        // A different kind or numbering instance at the same level is a new list.
        if (
          top !== undefined &&
          top.level === li.ilvl &&
          (top.kind !== kind || top.numId !== li.numId)
        )
          close();
        const current = open[open.length - 1];
        if (current === undefined || current.level < li.ilvl) {
          const start = ctx.numbering.start(li.numId, li.ilvl);
          open.push({ kind, numId: li.numId, level: li.ilvl, start, items: [] });
        }
        open[open.length - 1]!.items.push([listItemBlock(child, ctx)]);
      } else if (child.name === "tbl") {
        closeAll();
        out.push(tableToBlock(child, ctx, depth));
      } else if (child.name === "sdt") {
        const sdtContent = findChild(child, "sdtContent");
        if (sdtContent !== undefined) visit(sdtContent);
      } else if (child.name === "ins" || child.name === "moveTo" || child.name === "customXml") {
        visit(child);
      }
    }
  };
  visit(parent);
  closeAll();
  return out;
};

/** Create a DOCX Reader. */
export const makeDocxReader = (options?: DocxReaderOptions): Reader<DocxFeature> => {
  const maxDepth = options?.maxDepth ?? DEFAULT_MAX_NESTING_DEPTH;
  const read = (input: Content): Effect.Effect<Doc<DocxFeature>, ParseError> =>
    Effect.try({
      try: () => {
        const pkg = new OpcReader(contentToBytes(input), options?.limits);
        const docPath = pkg.rootTarget("/officeDocument", "word/document.xml");
        pkg.expectMainPart(docPath, "docx", MAIN_CONTENT_TYPES);
        const xml = pkg.text(docPath);
        if (xml === null) throw new OpcError("MissingPart", `missing document part: ${docPath}`);
        const rels = new Map<string, string>();
        let numberingPath: string | undefined;
        for (const r of pkg.rels(docPath)) {
          rels.set(r.id, r.target);
          if (r.type.endsWith("/numbering")) numberingPath = r.target;
        }
        const numbering = parseNumbering(
          numberingPath === undefined ? null : pkg.xml(numberingPath),
        );

        const root = pkg.xml(docPath)!;
        const body = findChild(root, "body");
        if (body !== undefined && tableNesting(body) > maxDepth) throw new NestingLimit();
        const blocks =
          body === undefined
            ? []
            : bodyToBlocks(body, { rels, numbering }, { level: 1, max: maxDepth });
        return trustAs<DocxFeature>(document(blocks));
      },
      catch: (cause) =>
        cause instanceof NestingLimit
          ? new ParseError({
              format: "docx",
              code: "LimitExceeded",
              reason: `Document nests more than ${maxDepth} levels deep (maxDepth)`,
            })
          : ooxmlParseError("docx", cause),
    }).pipe(Effect.flatMap((doc) => limitNestingDepth("docx", doc, maxDepth)));
  return { format: "docx", profile: Docx, read };
};

/** The Context tag for the DOCX reader, so a program can depend on a DOCX reader and have one provided. */
export const DocxReaderTag = makeReaderTag<DocxFeature>("docx");
/** A Layer providing the default DOCX reader for {@link DocxReaderTag}. */
export const DocxReaderLive = Layer.succeed(DocxReaderTag, makeDocxReader());
