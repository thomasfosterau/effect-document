/**
 * The DOCX Writer: a DOCX-profile document -> .docx bytes.
 *
 * Emits a minimal-but-valid WordprocessingML package: paragraphs and runs with
 * bold/italic/underline/strike/super/sub/small-caps, headings via paragraph
 * styles, hyperlinks (with relationships), bullet/ordered lists (via a small
 * numbering part: one numbering instance per list, so each ordered list restarts at
 * its `start`; nested lists by `w:ilvl`), code blocks and tables. A styles
 * part defines the Heading1-6, Code, Hyperlink and TableGrid styles it refers to.
 */

import * as Predicate from "effect/Predicate";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import {
  type Block,
  type BlockOf,
  bytes,
  type Content,
  type Doc,
  type Header,
  type Inline,
  type InlineOf,
  isNodeIn,
  type Link,
  type Para,
  type Plain,
  makeWriterTag,
  type Quoted,
  type Table,
  type TableRow,
  WriteError,
  type Writer,
} from "@thomasfosterau/effect-document";
import {
  NS_CONTENT_TYPES,
  NS_PKG_REL,
  NS_REL_DOC,
  XML_DECL,
  escapeAttr,
  escapeXml,
  zipParts,
} from "../shared/index.ts";
import { Docx, type DocxFeature } from "./profile.ts";

const NS_W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";

const CT_DOCUMENT =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml";
const CT_NUMBERING = "application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml";
const CT_STYLES = "application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml";
const CT_RELS = "application/vnd.openxmlformats-package.relationships+xml";
const REL_OFFICE_DOCUMENT = NS_REL_DOC + "/officeDocument";
const REL_HYPERLINK = NS_REL_DOC + "/hyperlink";
const REL_NUMBERING = NS_REL_DOC + "/numbering";
const REL_STYLES = NS_REL_DOC + "/styles";

const ABSTRACT_BULLET = 0;
const ABSTRACT_ORDERED = 1;
/** WordprocessingML list levels run 0-8. */
const MAX_ILVL = 8;

/**
 * The left indent, in twentieths of a point, of list level `ilvl`: the
 * numbering part indents each level by it, and an item's blocks after its
 * first paragraph are indented to it, as Word indents a list's continuation
 * paragraphs, so the reader can put them back in the item (#195).
 */
const levelIndent = (ilvl: number): number => 720 * (ilvl + 1);

/** A paragraph's `w:ind`, or nothing outside a list item (`indent` 0). */
const indXml = (indent: number): string => (indent > 0 ? `<w:ind w:left="${indent}"/>` : "");

/** A paragraph's `w:pPr` from its style and indent, or nothing if it has neither. */
const pPrXml = (style: string, indent: number): string =>
  style === "" && indent === 0
    ? ""
    : `<w:pPr>${style === "" ? "" : `<w:pStyle w:val="${style}"/>`}${indXml(indent)}</w:pPr>`;

// ============================================================================
// Run rendering
// ============================================================================

interface Fmt {
  /** Inside a hyperlink: the `Hyperlink` character style gives it its look. */
  link?: boolean | undefined;
  b?: boolean | undefined;
  i?: boolean | undefined;
  u?: boolean | undefined;
  strike?: boolean | undefined;
  vert?: "superscript" | "subscript" | undefined;
  caps?: boolean | undefined;
}

/** Collects hyperlink relationships and list numbering while rendering. */
class RelCollector {
  private readonly entries: Array<{ id: string; url: string }> = [];
  /** Each list's numbering instance, in numId order: a bullet list, or an ordered list's start. */
  private readonly lists: Array<number | "bullet"> = [];
  addHyperlink(url: string): string {
    const id = `rIdH${this.entries.length + 1}`;
    this.entries.push({ id, url });
    return id;
  }
  get hyperlinks(): ReadonlyArray<{ id: string; url: string }> {
    return this.entries;
  }
  /**
   * A fresh numbering instance for one list: a bullet list, or an ordered
   * list starting at `start`. Every list gets its own, so adjacent lists of
   * the same kind stay separate lists (#109) and each ordered list restarts.
   */
  addList(start: number | "bullet"): number {
    this.lists.push(start);
    return this.lists.length;
  }
  /** The numbering instances as (numId, bullet or start). */
  get numberings(): ReadonlyArray<{ numId: number; start: number | "bullet" }> {
    return this.lists.map((start, n) => ({ numId: n + 1, start }));
  }
  private bookmarks = 0;
  /**
   * `inner` (a paragraph's runs) inside a bookmark named `name`, if there is
   * one: how a heading's id is kept (#184), and what a `#name` link goes to.
   * Each bookmark gets a fresh `w:id`.
   */
  bookmarked(name: string | undefined, inner: string): string {
    if (name === undefined || name === "") return inner;
    const id = this.bookmarks++;
    return `<w:bookmarkStart w:id="${id}" w:name="${escapeAttr(name)}"/>${inner}<w:bookmarkEnd w:id="${id}"/>`;
  }
}

const rPr = (f: Fmt): string => {
  const parts: string[] = [];
  // w:rStyle comes first in w:rPr (CT_RPr's sequence)
  if (f.link) parts.push('<w:rStyle w:val="Hyperlink"/>');
  if (f.b) parts.push("<w:b/>");
  if (f.i) parts.push("<w:i/>");
  if (f.u) parts.push('<w:u w:val="single"/>');
  if (f.strike) parts.push("<w:strike/>");
  if (f.caps) parts.push("<w:smallCaps/>");
  if (f.vert) parts.push(`<w:vertAlign w:val="${f.vert}"/>`);
  return Arr.isReadonlyArrayNonEmpty(parts) ? `<w:rPr>${parts.join("")}</w:rPr>` : "";
};

/** Run content for text: `\n` becomes `w:br` and `\t` becomes `w:tab`. */
const runContent = (text: string): string =>
  text
    .split(/(\r\n|\n|\r|\t)/)
    .map((part) =>
      part === "\t"
        ? "<w:tab/>"
        : part === "\n" || part === "\r\n" || part === "\r"
          ? "<w:br/>"
          : part === ""
            ? ""
            : `<w:t xml:space="preserve">${escapeXml(part)}</w:t>`,
    )
    .join("");

const run = (text: string, f: Fmt): string => `<w:r>${rPr(f)}${runContent(text)}</w:r>`;

const inlineRuns = (ns: ReadonlyArray<Inline>, f: Fmt, rel: RelCollector): string =>
  ns.map((n) => inlineToRuns(n, f, rel)).join("");

const quotedRuns = (n: Quoted, f: Fmt, rel: RelCollector): string => {
  const [open, close] = n.quoteType === "single" ? ["\u2018", "\u2019"] : ["\u201C", "\u201D"];
  return run(open, f) + inlineRuns(n.content, f, rel) + run(close, f);
};

const hyperlinkRuns = (n: Link, f: Fmt, rel: RelCollector): string => {
  // "#name" links to a bookmark in this document; anything else is external.
  const target = n.target.url.startsWith("#")
    ? `w:anchor="${escapeAttr(n.target.url.substring(1))}"`
    : `r:id="${rel.addHyperlink(n.target.url)}"`;
  // The look comes from the Hyperlink style rather than a direct underline,
  // so the reader doesn't mistake it for an `Underline` (#109).
  return `<w:hyperlink ${target}>${inlineRuns(n.content, { ...f, link: true }, rel)}</w:hyperlink>`;
};

/**
 * An inline of the DOCX profile. The table is exhaustive over the profile's
 * inlines, so a feature added to the profile without a rendering here is a
 * compile error (#109).
 */
const docxInline = (n: InlineOf<DocxFeature>, f: Fmt, rel: RelCollector): string =>
  Match.valueTags(n, {
    Str: (s) => run(s.text, f),
    Space: () => run(" ", f),
    SoftBreak: () => run(" ", f),
    LineBreak: () => `<w:r>${rPr(f)}<w:br/></w:r>`,
    Emph: (m) => inlineRuns(m.content, { ...f, i: true }, rel),
    Strong: (m) => inlineRuns(m.content, { ...f, b: true }, rel),
    Underline: (m) => inlineRuns(m.content, { ...f, u: true }, rel),
    Strikeout: (m) => inlineRuns(m.content, { ...f, strike: true }, rel),
    Superscript: (m) => inlineRuns(m.content, { ...f, vert: "superscript" }, rel),
    Subscript: (m) => inlineRuns(m.content, { ...f, vert: "subscript" }, rel),
    SmallCaps: (m) => inlineRuns(m.content, { ...f, caps: true }, rel),
    Link: (l) => hyperlinkRuns(l, f, rel),
  });

/**
 * An inline outside the DOCX profile, in a document handed over with
 * `trustAs`: inline code as a plain run and quotations in quotation marks
 * (neither reads back as such); anything else is dropped.
 */
const otherInline = (n: Inline, f: Fmt, rel: RelCollector): string =>
  Predicate.isTagged(n, "Code")
    ? run(n.text, f)
    : Predicate.isTagged(n, "Quoted")
      ? quotedRuns(n, f, rel)
      : "";

const inlineToRuns = (n: Inline, f: Fmt, rel: RelCollector): string =>
  isNodeIn(Docx, n) ? docxInline(n, f, rel) : otherInline(n, f, rel);

// ============================================================================
// Block rendering
// ============================================================================

/** A numbered list paragraph: an item's lead paragraph, or a heading in its `HeadingN` style. */
const listParagraph = (
  lead: Option.Option<Para | Plain | Header>,
  numId: number,
  ilvl: number,
  rel: RelCollector,
): string => {
  const style = Option.match(
    Option.filter(lead, (b): b is Header => Predicate.isTagged(b, "Header")),
    {
      onNone: () => "",
      onSome: (h) => `<w:pStyle w:val="Heading${h.level}"/>`,
    },
  );
  const content = Option.match(lead, { onNone: () => [], onSome: (p) => p.content });
  const id = Option.match(lead, {
    onNone: () => undefined,
    onSome: (p) => (Predicate.isTagged(p, "Header") ? p.attr?.id : undefined),
  });
  return `<w:p><w:pPr>${style}<w:numPr><w:ilvl w:val="${ilvl}"/><w:numId w:val="${numId}"/></w:numPr></w:pPr>${rel.bookmarked(id, inlineRuns(content, {}, rel))}</w:p>`;
};

/**
 * Render a list. Each item's first paragraph carries the numbering (an empty
 * one when the item starts with another block); nested lists go one `w:ilvl`
 * deeper, and the item's other blocks follow indented to its level, as
 * Word's continuation paragraphs are, so they read back into the item (#195).
 */
const renderList = (
  items: ReadonlyArray<ReadonlyArray<Block>>,
  numId: number,
  ilvl: number,
  rel: RelCollector,
): string =>
  items
    .map((item) => {
      const [first, ...rest] = item;
      const lead = Option.filter(
        Option.fromUndefinedOr(first),
        (b): b is Para | Plain | Header =>
          Predicate.isTagged(b, "Para") ||
          Predicate.isTagged(b, "Plain") ||
          Predicate.isTagged(b, "Header"),
      );
      return (
        listParagraph(lead, numId, ilvl, rel) +
        (Option.isSome(lead) ? rest : item)
          .map((b) => renderBlock(b, rel, Math.min(ilvl + 1, MAX_ILVL), levelIndent(ilvl)))
          .join("")
      );
    })
    .join("");

const renderRow = (row: TableRow, isHeader: boolean, rel: RelCollector): string => {
  const cells = row.cells
    .map((c) => {
      const inner = c.content.map((b) => renderBlock(b, rel, 0)).join("") || "<w:p/>";
      return `<w:tc><w:tcPr/>${inner}</w:tc>`;
    })
    .join("");
  return `<w:tr>${isHeader ? "<w:trPr><w:tblHeader/></w:trPr>" : ""}${cells}</w:tr>`;
};

const renderTable = (t: Table, rel: RelCollector, indent: number): string => {
  const cols = [...t.head, ...t.body, ...t.foot].reduce((m, r) => Math.max(m, r.cells.length), 0);
  const grid = `<w:tblGrid>${Array.from({ length: cols }, () => '<w:gridCol w:w="2400"/>').join("")}</w:tblGrid>`;
  const rows = [
    ...t.head.map((r) => renderRow(r, true, rel)),
    ...t.body.map((r) => renderRow(r, false, rel)),
    ...t.foot.map((r) => renderRow(r, false, rel)),
  ].join("");
  return `<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="0" w:type="auto"/>${indent > 0 ? `<w:tblInd w:w="${indent}" w:type="dxa"/>` : ""}</w:tblPr>${grid}${rows}</w:tbl>`;
};

/**
 * A block of the DOCX profile; `ilvl` is the list level a nested list here
 * would take (0 outside lists) and `indent` the left indent of a list item's
 * continuation block (0 outside lists). Exhaustive over the profile's blocks (#109).
 */
const docxBlock = (
  b: BlockOf<DocxFeature>,
  rel: RelCollector,
  ilvl: number,
  indent: number,
): string =>
  Match.valueTags(b, {
    Para: (p) => `<w:p>${pPrXml("", indent)}${inlineRuns(p.content, {}, rel)}</w:p>`,
    Plain: (p) => `<w:p>${pPrXml("", indent)}${inlineRuns(p.content, {}, rel)}</w:p>`,
    Header: (h) =>
      `<w:p>${pPrXml(`Heading${h.level}`, indent)}${rel.bookmarked(h.attr?.id, inlineRuns(h.content, {}, rel))}</w:p>`,
    BulletList: (l) => renderList(l.items, rel.addList("bullet"), ilvl, rel),
    OrderedList: (l) => renderList(l.items, rel.addList(l.start ?? 1), ilvl, rel),
    CodeBlock: (c) => `<w:p>${pPrXml("Code", indent)}<w:r>${runContent(c.text)}</w:r></w:p>`,
    Table: (t) => renderTable(t, rel, indent),
  });

/**
 * A block outside the DOCX profile, in a document handed over with
 * `trustAs`: a rule as a bordered empty paragraph, block quotes and divs
 * flattened into their content, a line block as one paragraph per line
 * (none of which reads back as such); anything else is dropped.
 */
const otherBlock = (b: Block, rel: RelCollector, ilvl: number, indent: number): string => {
  if (Predicate.isTagged(b, "HorizontalRule")) {
    return `<w:p><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="auto"/></w:pBdr>${indXml(indent)}</w:pPr></w:p>`;
  } else if (Predicate.isTagged(b, "BlockQuote") || Predicate.isTagged(b, "Div")) {
    return b.content.map((x) => renderBlock(x, rel, ilvl, indent)).join("");
  } else if (Predicate.isTagged(b, "LineBlock")) {
    return b.lines
      .map((line) => `<w:p>${pPrXml("", indent)}${inlineRuns(line, {}, rel)}</w:p>`)
      .join("");
  }
  return "";
};

/**
 * `ilvl`: the list level a nested list here would take (0 outside lists);
 * `indent`: the left indent of a list item's continuation block (0 outside lists).
 */
const renderBlock = (b: Block, rel: RelCollector, ilvl: number, indent = 0): string =>
  isNodeIn(Docx, b) ? docxBlock(b, rel, ilvl, indent) : otherBlock(b, rel, ilvl, indent);

// ============================================================================
// Package parts
// ============================================================================

const documentXml = (body: string): string =>
  XML_DECL +
  `<w:document xmlns:w="${NS_W}" xmlns:r="${NS_REL_DOC}">` +
  `<w:body>${body}<w:sectPr/></w:body>` +
  `</w:document>`;

const levels = (fmt: (ilvl: number) => string): string =>
  Array.from(
    { length: MAX_ILVL + 1 },
    (_, ilvl) =>
      `<w:lvl w:ilvl="${ilvl}"><w:start w:val="1"/>${fmt(ilvl)}` +
      `<w:pPr><w:ind w:left="${levelIndent(ilvl)}" w:hanging="360"/></w:pPr></w:lvl>`,
  ).join("");

const numberingXml = (rel: RelCollector): string =>
  XML_DECL +
  `<w:numbering xmlns:w="${NS_W}">` +
  `<w:abstractNum w:abstractNumId="${ABSTRACT_BULLET}">` +
  levels(() => `<w:numFmt w:val="bullet"/><w:lvlText w:val="&#8226;"/>`) +
  `</w:abstractNum>` +
  `<w:abstractNum w:abstractNumId="${ABSTRACT_ORDERED}">` +
  levels((ilvl) => `<w:numFmt w:val="decimal"/><w:lvlText w:val="%${ilvl + 1}."/>`) +
  `</w:abstractNum>` +
  rel.numberings
    .map(({ numId, start }) =>
      start === "bullet"
        ? `<w:num w:numId="${numId}"><w:abstractNumId w:val="${ABSTRACT_BULLET}"/></w:num>`
        : `<w:num w:numId="${numId}"><w:abstractNumId w:val="${ABSTRACT_ORDERED}"/>` +
          `<w:lvlOverride w:ilvl="0"><w:startOverride w:val="${start}"/></w:lvlOverride></w:num>`,
    )
    .join("") +
  `</w:numbering>`;

const headingStyle = (level: number): string =>
  `<w:style w:type="paragraph" w:styleId="Heading${level}"><w:name w:val="heading ${level}"/>` +
  `<w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/>` +
  `<w:pPr><w:keepNext/><w:spacing w:before="240" w:after="60"/><w:outlineLvl w:val="${level - 1}"/></w:pPr>` +
  `<w:rPr><w:b/><w:sz w:val="${[32, 28, 26, 24, 22, 22][level - 1]}"/></w:rPr></w:style>`;

const stylesXml = (): string =>
  XML_DECL +
  `<w:styles xmlns:w="${NS_W}">` +
  `<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>` +
  [1, 2, 3, 4, 5, 6].map(headingStyle).join("") +
  `<w:style w:type="paragraph" w:styleId="Code"><w:name w:val="Code"/><w:basedOn w:val="Normal"/>` +
  `<w:rPr><w:rFonts w:ascii="Courier New" w:hAnsi="Courier New" w:cs="Courier New"/><w:sz w:val="20"/></w:rPr></w:style>` +
  `<w:style w:type="character" w:styleId="Hyperlink"><w:name w:val="Hyperlink"/>` +
  `<w:rPr><w:color w:val="0563C1"/><w:u w:val="single"/></w:rPr></w:style>` +
  `<w:style w:type="table" w:default="1" w:styleId="TableNormal"><w:name w:val="Normal Table"/></w:style>` +
  `<w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/><w:basedOn w:val="TableNormal"/>` +
  `<w:tblPr><w:tblBorders>` +
  ["top", "left", "bottom", "right", "insideH", "insideV"]
    .map((side) => `<w:${side} w:val="single" w:sz="4" w:space="0" w:color="auto"/>`)
    .join("") +
  `</w:tblBorders></w:tblPr></w:style>` +
  `</w:styles>`;

const contentTypesXml = (): string =>
  XML_DECL +
  `<Types xmlns="${NS_CONTENT_TYPES}">` +
  `<Default Extension="rels" ContentType="${CT_RELS}"/>` +
  `<Default Extension="xml" ContentType="application/xml"/>` +
  `<Override PartName="/word/document.xml" ContentType="${CT_DOCUMENT}"/>` +
  `<Override PartName="/word/numbering.xml" ContentType="${CT_NUMBERING}"/>` +
  `<Override PartName="/word/styles.xml" ContentType="${CT_STYLES}"/>` +
  `</Types>`;

const rootRelsXml = (): string =>
  XML_DECL +
  `<Relationships xmlns="${NS_PKG_REL}">` +
  `<Relationship Id="rId1" Type="${REL_OFFICE_DOCUMENT}" Target="word/document.xml"/>` +
  `</Relationships>`;

const documentRelsXml = (rel: RelCollector): string =>
  XML_DECL +
  `<Relationships xmlns="${NS_PKG_REL}">` +
  `<Relationship Id="rIdNum" Type="${REL_NUMBERING}" Target="numbering.xml"/>` +
  `<Relationship Id="rIdStyles" Type="${REL_STYLES}" Target="styles.xml"/>` +
  rel.hyperlinks
    .map(
      (h) =>
        `<Relationship Id="${h.id}" Type="${REL_HYPERLINK}" Target="${escapeAttr(h.url)}" TargetMode="External"/>`,
    )
    .join("") +
  `</Relationships>`;

// ============================================================================
// Writer
// ============================================================================

/** Options for the DOCX writer. */
export interface DocxWriterOptions {
  readonly compressionLevel?: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | undefined;
}

/** Create a DOCX Writer. */
export const makeDocxWriter = (options?: DocxWriterOptions): Writer<DocxFeature> => {
  const level = options?.compressionLevel ?? 6;
  const write = (doc: Doc<DocxFeature>): Effect.Effect<Content, WriteError> =>
    Effect.try({
      try: () => {
        const rel = new RelCollector();
        const body = doc.blocks.map((b) => renderBlock(b, rel, 0)).join("");
        const files = {
          "[Content_Types].xml": contentTypesXml(),
          "_rels/.rels": rootRelsXml(),
          "word/document.xml": documentXml(body),
          "word/numbering.xml": numberingXml(rel),
          "word/styles.xml": stylesXml(),
          "word/_rels/document.xml.rels": documentRelsXml(rel),
        };
        return bytes(zipParts(files, level));
      },
      catch: (cause) =>
        new WriteError({
          format: "docx",
          reason: `Failed to generate docx: ${String(cause)}`,
          cause,
        }),
    });
  return { format: "docx", profile: Docx, write };
};

/** The Context tag for the DOCX writer, so a program can depend on a DOCX writer and have one provided. */
export const DocxWriterTag = makeWriterTag<DocxFeature>("docx");
/** A Layer providing the default DOCX writer for {@link DocxWriterTag}. */
export const DocxWriterLive = Layer.succeed(DocxWriterTag, makeDocxWriter());
