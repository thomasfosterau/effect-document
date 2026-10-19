/**
 * The DOCX Writer: a DOCX-profile document -> .docx bytes.
 *
 * Emits a minimal-but-valid WordprocessingML package: paragraphs and runs with
 * bold/italic/underline/strike/super/sub/small-caps, headings via paragraph
 * styles, hyperlinks (with relationships), bullet/ordered lists (via a small
 * numbering part) and tables.
 */

import { Effect, Layer } from "effect";
import {
  type Block, bytes, type Content, type Doc, type Inline, makeWriterTag, type Table, type TableRow,
  WriteError, type Writer,
} from "@thomasfosterau/effect-document";
import {
  NS_CONTENT_TYPES, NS_PKG_REL, NS_REL_DOC, XML_DECL, escapeXml, zipParts,
} from "../shared/index.js";
import { Docx, type DocxFeature } from "./profile.js";

const NS_W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";

const CT_DOCUMENT =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml";
const CT_NUMBERING =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml";
const CT_RELS = "application/vnd.openxmlformats-package.relationships+xml";
const REL_OFFICE_DOCUMENT = NS_REL_DOC + "/officeDocument";
const REL_HYPERLINK = NS_REL_DOC + "/hyperlink";
const REL_NUMBERING = NS_REL_DOC + "/numbering";

const NUM_BULLET = 1;
const NUM_ORDERED = 2;

// ============================================================================
// Run rendering
// ============================================================================

interface Fmt {
  b?: boolean;
  i?: boolean;
  u?: boolean;
  strike?: boolean;
  vert?: "superscript" | "subscript";
  caps?: boolean;
}

/** Collects hyperlink relationships while rendering. */
class RelCollector {
  private readonly entries: Array<{ id: string; url: string }> = [];
  addHyperlink(url: string): string {
    const id = `rIdH${this.entries.length + 1}`;
    this.entries.push({ id, url });
    return id;
  }
  get hyperlinks(): ReadonlyArray<{ id: string; url: string }> {
    return this.entries;
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
  return parts.length > 0 ? `<w:rPr>${parts.join("")}</w:rPr>` : "";
};

const run = (text: string, f: Fmt): string =>
  `<w:r>${rPr(f)}<w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r>`;

const inlineRuns = (ns: ReadonlyArray<Inline>, f: Fmt, rel: RelCollector): string =>
  ns.map((n) => inlineToRuns(n, f, rel)).join("");

const inlineToRuns = (n: Inline, f: Fmt, rel: RelCollector): string => {
  switch (n._tag) {
    case "Str": return run(n.text, f);
    case "Space": case "SoftBreak": return run(" ", f);
    case "LineBreak": return `<w:r>${rPr(f)}<w:br/></w:r>`;
    case "Emph": return inlineRuns(n.content, { ...f, i: true }, rel);
    case "Strong": return inlineRuns(n.content, { ...f, b: true }, rel);
    case "Underline": return inlineRuns(n.content, { ...f, u: true }, rel);
    case "Strikeout": return inlineRuns(n.content, { ...f, strike: true }, rel);
    case "Superscript": return inlineRuns(n.content, { ...f, vert: "superscript" }, rel);
    case "Subscript": return inlineRuns(n.content, { ...f, vert: "subscript" }, rel);
    case "SmallCaps": return inlineRuns(n.content, { ...f, caps: true }, rel);
    case "Code": return run(n.text, f);
    case "Quoted": return inlineRuns(n.content, f, rel);
    case "Link": {
      const id = rel.addHyperlink(n.target.url);
      return `<w:hyperlink r:id="${id}">${inlineRuns(n.content, { ...f, u: true }, rel)}</w:hyperlink>`;
    }
    default: return "";
  }
};

// ============================================================================
// Block rendering
// ============================================================================

const itemInlines = (blocks: ReadonlyArray<Block>): Inline[] =>
  blocks.flatMap((b) =>
    b._tag === "Para" || b._tag === "Plain" || b._tag === "Header" ? [...b.content] : []
  );

const listItem = (blocks: ReadonlyArray<Block>, numId: number, rel: RelCollector): string =>
  `<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="${numId}"/></w:numPr></w:pPr>${inlineRuns(itemInlines(blocks), {}, rel)}</w:p>`;

const renderRow = (row: TableRow, isHeader: boolean, rel: RelCollector): string => {
  const cells = row.cells
    .map((c) => {
      const inner = c.content.map((b) => renderBlock(b, rel)).join("") || "<w:p/>";
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

const renderBlock = (b: Block, rel: RelCollector): string => {
  switch (b._tag) {
    case "Para": case "Plain":
      return `<w:p>${inlineRuns(b.content, {}, rel)}</w:p>`;
    case "Header":
      return `<w:p><w:pPr><w:pStyle w:val="Heading${b.level}"/></w:pPr>${inlineRuns(b.content, {}, rel)}</w:p>`;
    case "HorizontalRule":
      return '<w:p><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="auto"/></w:pBdr></w:pPr></w:p>';
    case "BulletList":
      return b.items.map((it) => listItem(it, NUM_BULLET, rel)).join("");
    case "OrderedList":
      return b.items.map((it) => listItem(it, NUM_ORDERED, rel)).join("");
    case "BlockQuote": case "Div":
      return b.content.map((x) => renderBlock(x, rel)).join("");
    case "LineBlock":
      return b.lines.map((line) => `<w:p>${inlineRuns(line, {}, rel)}</w:p>`).join("");
    case "CodeBlock":
      return `<w:p><w:pPr><w:pStyle w:val="Code"/></w:pPr><w:r><w:t xml:space="preserve">${escapeXml(b.text)}</w:t></w:r></w:p>`;
    case "Table":
      return renderTable(b, rel);
    default:
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

const numberingXml = (): string =>
  XML_DECL +
  `<w:numbering xmlns:w="${NS_W}">` +
  `<w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/><w:lvlText w:val="&#8226;"/></w:lvl></w:abstractNum>` +
  `<w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/></w:lvl></w:abstractNum>` +
  `<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>` +
  `<w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num>` +
  `</w:numbering>`;

const contentTypesXml = (): string =>
  XML_DECL +
  `<Types xmlns="${NS_CONTENT_TYPES}">` +
  `<Default Extension="rels" ContentType="${CT_RELS}"/>` +
  `<Default Extension="xml" ContentType="application/xml"/>` +
  `<Override PartName="/word/document.xml" ContentType="${CT_DOCUMENT}"/>` +
  `<Override PartName="/word/numbering.xml" ContentType="${CT_NUMBERING}"/>` +
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
  rel.hyperlinks
    .map(
      (h) =>
        `<Relationship Id="${h.id}" Type="${REL_HYPERLINK}" Target="${escapeXml(h.url)}" TargetMode="External"/>`
    )
    .join("") +
  `</Relationships>`;

// ============================================================================
// Writer
// ============================================================================

export interface DocxWriterOptions {
  readonly compressionLevel?: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;
}

/** Create a DOCX Writer. */
export const makeDocxWriter = (options?: DocxWriterOptions): Writer<DocxFeature> => {
  const level = options?.compressionLevel ?? 6;
  const write = (doc: Doc<DocxFeature>): Effect.Effect<Content, WriteError> =>
    Effect.try({
      try: () => {
        const rel = new RelCollector();
        const body = doc.blocks.map((b) => renderBlock(b, rel)).join("");
        const files: Record<string, string> = {
          "[Content_Types].xml": contentTypesXml(),
          "_rels/.rels": rootRelsXml(),
          "word/document.xml": documentXml(body),
          "word/numbering.xml": numberingXml(),
          "word/_rels/document.xml.rels": documentRelsXml(rel),
        };
        return bytes(zipParts(files, level));
      },
      catch: (cause) =>
        new WriteError({ format: "docx", reason: `Failed to generate docx: ${String(cause)}`, cause }),
    });
  return { format: "docx", profile: Docx, write };
};

export const DocxWriterTag = makeWriterTag<DocxFeature>("docx");
export const DocxWriterLive = Layer.succeed(DocxWriterTag, makeDocxWriter());
