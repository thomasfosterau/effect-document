/**
 * The DOCX Writer: a DOCX-profile document -> .docx bytes.
 *
 * Emits a minimal-but-valid WordprocessingML package: paragraphs and runs with
 * bold/italic/underline/strike/super/sub/small-caps, headings via paragraph
 * styles, hyperlinks (with relationships), bullet/ordered lists (via a small
 * numbering part: one numbering instance per ordered list, so each restarts at
 * its `start`; nested lists by `w:ilvl`), code blocks and tables. A styles
 * part defines the Heading1-6, Code and TableGrid styles it refers to.
 */

import * as Predicate from "effect/Predicate";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as HashMap from "effect/HashMap";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import {
  type Block,
  bytes,
  type Content,
  type Doc,
  type Inline,
  type Link,
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

/** The shared bullet numbering instance; ordered lists each get their own. */
const NUM_BULLET = 1;
const ABSTRACT_BULLET = 0;
const ABSTRACT_ORDERED = 1;
/** WordprocessingML list levels run 0-8. */
const MAX_ILVL = 8;

// ============================================================================
// Run rendering
// ============================================================================

interface Fmt {
  b?: boolean | undefined;
  i?: boolean | undefined;
  u?: boolean | undefined;
  strike?: boolean | undefined;
  vert?: "superscript" | "subscript" | undefined;
  caps?: boolean | undefined;
}

/** Collects hyperlink relationships and ordered-list numbering while rendering. */
class RelCollector {
  private readonly entries: Array<{ id: string; url: string }> = [];
  private readonly ordered: number[] = [];
  addHyperlink(url: string): string {
    const id = `rIdH${this.entries.length + 1}`;
    this.entries.push({ id, url });
    return id;
  }
  get hyperlinks(): ReadonlyArray<{ id: string; url: string }> {
    return this.entries;
  }
  /** A fresh numbering instance for one ordered list, starting at `start`. */
  addOrderedList(start: number): number {
    this.ordered.push(start);
    return NUM_BULLET + this.ordered.length;
  }
  /** The ordered-list instances as (numId, start). */
  get orderedLists(): ReadonlyArray<{ numId: number; start: number }> {
    return this.ordered.map((start, n) => ({ numId: NUM_BULLET + n + 1, start }));
  }
}

const rPr = (f: Fmt): string => {
  const parts: string[] = [];
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

/** The run formatting each mark inline adds to its content. */
const MARKS = HashMap.make<ReadonlyArray<readonly [string, Fmt]>>(
  ["Emph", { i: true }],
  ["Strong", { b: true }],
  ["Underline", { u: true }],
  ["Strikeout", { strike: true }],
  ["Superscript", { vert: "superscript" }],
  ["Subscript", { vert: "subscript" }],
  ["SmallCaps", { caps: true }],
);

const quotedRuns = (n: Quoted, f: Fmt, rel: RelCollector): string => {
  const [open, close] = n.quoteType === "single" ? ["\u2018", "\u2019"] : ["\u201C", "\u201D"];
  return run(open, f) + inlineRuns(n.content, f, rel) + run(close, f);
};

const hyperlinkRuns = (n: Link, f: Fmt, rel: RelCollector): string => {
  // "#name" links to a bookmark in this document; anything else is external.
  const target = n.target.url.startsWith("#")
    ? `w:anchor="${escapeAttr(n.target.url.substring(1))}"`
    : `r:id="${rel.addHyperlink(n.target.url)}"`;
  return `<w:hyperlink ${target}>${inlineRuns(n.content, { ...f, u: true }, rel)}</w:hyperlink>`;
};

const inlineToRuns = (n: Inline, f: Fmt, rel: RelCollector): string => {
  if (Predicate.isTagged(n, "Str") || Predicate.isTagged(n, "Code")) return run(n.text, f);
  if (Predicate.isTagged(n, "Space") || Predicate.isTagged(n, "SoftBreak")) return run(" ", f);
  if (Predicate.isTagged(n, "LineBreak")) return `<w:r>${rPr(f)}<w:br/></w:r>`;
  if (Predicate.isTagged(n, "Quoted")) return quotedRuns(n, f, rel);
  if (Predicate.isTagged(n, "Link")) return hyperlinkRuns(n, f, rel);
  if (Predicate.isTagged(n, "Note") || !("content" in n)) return "";
  // the marks; the profile has no other inline with content
  const mark = HashMap.get(MARKS, n._tag);
  return Option.isSome(mark) ? inlineRuns(n.content, { ...f, ...mark.value }, rel) : "";
};

// ============================================================================
// Block rendering
// ============================================================================

const listParagraph = (
  inlines: ReadonlyArray<Inline>,
  numId: number,
  ilvl: number,
  rel: RelCollector,
): string =>
  `<w:p><w:pPr><w:numPr><w:ilvl w:val="${ilvl}"/><w:numId w:val="${numId}"/></w:numPr></w:pPr>${inlineRuns(inlines, {}, rel)}</w:p>`;

/**
 * Render a list. Each item's first paragraph carries the numbering; nested
 * lists go one `w:ilvl` deeper, and any other blocks in the item follow as
 * ordinary blocks rather than being dropped.
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
      const lead =
        first !== undefined &&
        (Predicate.isTagged(first, "Para") ||
          Predicate.isTagged(first, "Plain") ||
          Predicate.isTagged(first, "Header"));
      return (
        listParagraph(lead ? first.content : [], numId, ilvl, rel) +
        (lead ? rest : item).map((b) => renderBlock(b, rel, Math.min(ilvl + 1, MAX_ILVL))).join("")
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

const renderTable = (t: Table, rel: RelCollector): string => {
  const cols = [...t.head, ...t.body, ...t.foot].reduce((m, r) => Math.max(m, r.cells.length), 0);
  const grid = `<w:tblGrid>${Array.from({ length: cols }, () => '<w:gridCol w:w="2400"/>').join("")}</w:tblGrid>`;
  const rows = [
    ...t.head.map((r) => renderRow(r, true, rel)),
    ...t.body.map((r) => renderRow(r, false, rel)),
    ...t.foot.map((r) => renderRow(r, false, rel)),
  ].join("");
  return `<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="0" w:type="auto"/></w:tblPr>${grid}${rows}</w:tbl>`;
};

/** `ilvl`: the list level a nested list here would take (0 outside lists). */
const renderBlock = (b: Block, rel: RelCollector, ilvl: number): string => {
  if (Predicate.isTagged(b, "Para") || Predicate.isTagged(b, "Plain")) {
    return `<w:p>${inlineRuns(b.content, {}, rel)}</w:p>`;
  } else if (Predicate.isTagged(b, "Header")) {
    return `<w:p><w:pPr><w:pStyle w:val="Heading${b.level}"/></w:pPr>${inlineRuns(b.content, {}, rel)}</w:p>`;
  } else if (Predicate.isTagged(b, "HorizontalRule")) {
    return '<w:p><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="auto"/></w:pBdr></w:pPr></w:p>';
  } else if (Predicate.isTagged(b, "BulletList")) {
    return renderList(b.items, NUM_BULLET, ilvl, rel);
  } else if (Predicate.isTagged(b, "OrderedList")) {
    return renderList(b.items, rel.addOrderedList(b.start ?? 1), ilvl, rel);
  } else if (Predicate.isTagged(b, "BlockQuote") || Predicate.isTagged(b, "Div")) {
    return b.content.map((x) => renderBlock(x, rel, ilvl)).join("");
  } else if (Predicate.isTagged(b, "LineBlock")) {
    return b.lines.map((line) => `<w:p>${inlineRuns(line, {}, rel)}</w:p>`).join("");
  } else if (Predicate.isTagged(b, "CodeBlock")) {
    return `<w:p><w:pPr><w:pStyle w:val="Code"/></w:pPr><w:r>${runContent(b.text)}</w:r></w:p>`;
  } else if (Predicate.isTagged(b, "Table")) {
    return renderTable(b, rel);
  } else {
    return "";
  }
};

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
      `<w:pPr><w:ind w:left="${720 * (ilvl + 1)}" w:hanging="360"/></w:pPr></w:lvl>`,
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
  `<w:num w:numId="${NUM_BULLET}"><w:abstractNumId w:val="${ABSTRACT_BULLET}"/></w:num>` +
  rel.orderedLists
    .map(
      ({ numId, start }) =>
        `<w:num w:numId="${numId}"><w:abstractNumId w:val="${ABSTRACT_ORDERED}"/>` +
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

export const DocxWriterTag = makeWriterTag<DocxFeature>("docx");
export const DocxWriterLive = Layer.succeed(DocxWriterTag, makeDocxWriter());
