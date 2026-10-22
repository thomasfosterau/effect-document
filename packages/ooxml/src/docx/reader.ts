/**
 * The DOCX Reader: .docx bytes -> a prose document in the DOCX profile.
 *
 * Parses `word/document.xml`: paragraphs (headings via `w:pStyle`, list items
 * via `w:numPr`), runs (bold/italic/underline/strike/super/sub/small-caps),
 * hyperlinks (resolved through the document relationships) and tables.
 */

import { Effect, Layer } from "effect";
import {
  type Block, BulletList, type Content, contentToBytes, type Doc, document, Emph, Header,
  type Inline, LineBreak, Link, makeReaderTag, OrderedList, Para, ParseError, Plain, type Reader,
  SmallCaps, Str, Strikeout, Strong, Subscript, Superscript, Table, TableCell, TableRow, trustAs,
  Underline,
} from "@thomasfosterau/effect-document";
import {
  type OpcLimits, OpcReader, type XmlElement, findChild, findChildren, getAttr, ooxmlParseError,
} from "../shared/index.js";
import { Docx, type DocxFeature } from "./profile.js";

export interface DocxReaderOptions {
  /** Zip resource limits (entry count, inflated bytes); see `OpcLimits`. */
  readonly limits?: Partial<OpcLimits>;
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

const readFmt = (r: XmlElement): Fmt => {
  const rPr = findChild(r, "rPr");
  const has = (name: string): boolean => {
    if (rPr === undefined) return false;
    const el = findChild(rPr, name);
    if (el === undefined) return false;
    const val = getAttr(el, "val");
    return val !== "false" && val !== "0";
  };
  const vertEl = rPr === undefined ? undefined : findChild(rPr, "vertAlign");
  const vertVal = vertEl === undefined ? undefined : getAttr(vertEl, "val");
  return {
    b: has("b"),
    i: has("i"),
    u: has("u"),
    strike: has("strike"),
    caps: has("smallCaps"),
    vert: vertVal === "superscript" ? "superscript" : vertVal === "subscript" ? "subscript" : null,
  };
};

const runToInlines = (r: XmlElement, f: Fmt): Inline[] => {
  const out: Inline[] = [];
  for (const child of r.children) {
    if (child.name === "t") out.push(wrap(new Str({ text: child.text }), f));
    else if (child.name === "br") out.push(new LineBreak());
    else if (child.name === "tab") out.push(wrap(new Str({ text: "\t" }), f));
  }
  return out;
};

const paragraphInlines = (
  p: XmlElement,
  rels: ReadonlyMap<string, string>
): Inline[] => {
  const out: Inline[] = [];
  for (const child of p.children) {
    if (child.name === "r") {
      out.push(...runToInlines(child, readFmt(child)));
    } else if (child.name === "hyperlink") {
      const content = child.children
        .filter((c) => c.name === "r")
        .flatMap((r) => runToInlines(r, readFmt(r)));
      const id = getAttr(child, "id");
      const url = id !== undefined ? rels.get(id) : undefined;
      out.push(new Link({ content, target: { url: url ?? "" } }));
    }
  }
  return out;
};

const paragraphStyle = (p: XmlElement): string | undefined => {
  const pPr = findChild(p, "pPr");
  if (pPr === undefined) return undefined;
  const pStyle = findChild(pPr, "pStyle");
  return pStyle === undefined ? undefined : getAttr(pStyle, "val");
};

const listInfo = (p: XmlElement): { numId: string } | null => {
  const pPr = findChild(p, "pPr");
  if (pPr === undefined) return null;
  const numPr = findChild(pPr, "numPr");
  if (numPr === undefined) return null;
  const numIdEl = findChild(numPr, "numId");
  return { numId: numIdEl === undefined ? "1" : getAttr(numIdEl, "val") ?? "1" };
};

const paragraphToBlock = (
  p: XmlElement,
  rels: ReadonlyMap<string, string>
): Block => {
  const style = paragraphStyle(p);
  const inlines = paragraphInlines(p, rels);
  const heading = style?.match(/^Heading([1-6])$/);
  if (heading) return new Header({ level: Number.parseInt(heading[1]!, 10), content: inlines });
  return new Para({ content: inlines });
};

const cellToBlocks = (tc: XmlElement, rels: ReadonlyMap<string, string>): Block[] =>
  bodyToBlocks(tc, rels);

const tableToBlock = (tbl: XmlElement, rels: ReadonlyMap<string, string>): Table => {
  const head: TableRow[] = [];
  const body: TableRow[] = [];
  for (const tr of findChildren(tbl, "tr")) {
    const trPr = findChild(tr, "trPr");
    const isHeader = trPr !== undefined && findChild(trPr, "tblHeader") !== undefined;
    const cells = findChildren(tr, "tc").map(
      (tc) => new TableCell({ content: cellToBlocks(tc, rels) })
    );
    (isHeader ? head : body).push(new TableRow({ cells }));
  }
  return new Table({ colSpecs: [], head, body, foot: [] });
};

/** Convert an element's `w:p`/`w:tbl` children into blocks, grouping list items. */
const bodyToBlocks = (
  parent: XmlElement,
  rels: ReadonlyMap<string, string>
): Block[] => {
  const out: Block[] = [];
  let listItems: Block[][] = [];
  let listKind: "bullet" | "ordered" | null = null;

  const flushList = (): void => {
    if (listKind === null || listItems.length === 0) return;
    out.push(
      listKind === "ordered"
        ? new OrderedList({ items: listItems })
        : new BulletList({ items: listItems })
    );
    listItems = [];
    listKind = null;
  };

  for (const child of parent.children) {
    if (child.name === "p") {
      const li = listInfo(child);
      if (li !== null) {
        const kind: "bullet" | "ordered" = li.numId === "2" ? "ordered" : "bullet";
        if (listKind !== null && listKind !== kind) flushList();
        listKind = kind;
        listItems.push([new Plain({ content: paragraphInlines(child, rels) })]);
        continue;
      }
      flushList();
      out.push(paragraphToBlock(child, rels));
    } else if (child.name === "tbl") {
      flushList();
      out.push(tableToBlock(child, rels));
    }
  }
  flushList();
  return out;
};

/** Create a DOCX Reader. */
export const makeDocxReader = (options?: DocxReaderOptions): Reader<DocxFeature> => {
  const read = (input: Content): Effect.Effect<Doc<DocxFeature>, ParseError> =>
    Effect.try({
      try: () => {
        const pkg = new OpcReader(contentToBytes(input), options?.limits);
        const docPath = pkg.rootTarget("/officeDocument", "word/document.xml");
        pkg.expectMainPart(docPath, "docx", MAIN_CONTENT_TYPES);
        const xml = pkg.text(docPath);
        if (xml === null) throw new Error(`missing document part: ${docPath}`);
        const rels = new Map<string, string>();
        for (const r of pkg.rels(docPath)) rels.set(r.id, r.target);

        const root = pkg.xml(docPath)!;
        const body = findChild(root, "body");
        const blocks = body === undefined ? [] : bodyToBlocks(body, rels);
        return trustAs<DocxFeature>(document(blocks));
      },
      catch: (cause) =>
        ooxmlParseError("docx", cause),
    });
  return { format: "docx", profile: Docx, read };
};

export const DocxReaderTag = makeReaderTag<DocxFeature>("docx");
export const DocxReaderLive = Layer.succeed(DocxReaderTag, makeDocxReader());
