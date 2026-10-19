/**
 * Minimal XML utilities shared by the OOXML formats (xlsx, docx, pptx).
 *
 * OOXML is regular, attribute-driven XML; a small effect-parse grammar handles
 * the subset OOXML uses (elements, attributes, text content, self-closing
 * tags, declarations, comments, CDATA) and reports malformed input with its
 * line and column. This is not a general XML parser: there is no entity
 * declaration or namespace resolution. Namespace prefixes are stripped
 * from element names, so `<w:p>`, `<a:p>` and `<p:sp>` are navigated by their
 * local names; attribute keys keep their prefixes and `getAttr` matches either.
 */

import { type ParseError, Parser, Token } from "@thomasfosterau/effect-parse";
import type { Result } from "effect";

// ============================================================================
// Escaping
// ============================================================================

/** Escape text content for XML */
export const escapeXml = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Escape an attribute value for XML */
export const escapeAttr = (s: string): string =>
  escapeXml(s)
    .replace(/"/g, "&quot;")
    .replace(/\t/g, "&#9;")
    .replace(/\n/g, "&#10;")
    .replace(/\r/g, "&#13;");

/** Unescape XML text content and attribute values */
export const unescapeXml = (s: string): string =>
  s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16))
    )
    .replace(/&#(\d+);/g, (_, code: string) =>
      String.fromCodePoint(Number.parseInt(code, 10))
    )
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");

// ============================================================================
// Parsing
// ============================================================================

/** A parsed XML element */
export interface XmlElement {
  /** Local element name (namespace prefix stripped) */
  readonly name: string;
  /** Attributes (keys keep their prefixes, e.g. "r:id") */
  readonly attrs: Readonly<Record<string, string>>;
  readonly children: ReadonlyArray<XmlElement>;
  /** Concatenated direct text content */
  readonly text: string;
}

interface MutableElement {
  name: string;
  attrs: Record<string, string>;
  children: MutableElement[];
  text: string;
}

const localName = (name: string): string => {
  const colon = name.indexOf(":");
  return colon === -1 ? name : name.substring(colon + 1);
};

// ---- grammar ---------------------------------------------------------------

const space = " \t\r\n";
const ws = Token.takeWhile(space);
const ws1 = Token.takeWhile(space, { min: 1 });
const name = Token.takeTill(space + "/>=<", { min: 1 }).pipe(Parser.expected("name"));

const quoted = (quote: string) =>
  Parser.preceded(
    Token.literal(quote),
    Parser.cut(Parser.terminated(Token.takeTill(quote), Token.literal(quote)))
  );
const attribute = Parser.separatedPair(
  name,
  Parser.seq(ws, Token.literal("="), ws),
  Parser.map(Parser.alt(quoted('"'), quoted("'")), unescapeXml).pipe(Parser.expected("attribute value"))
);
const attributes = Parser.fromEntries(Parser.repeat(Parser.preceded(ws1, attribute)));

/** `open ... close`, committed once `open` has matched. */
const section = (open: string, close: string) =>
  Parser.preceded(
    Token.literal(open),
    Parser.cut(Parser.terminated(Token.takeUntil(close), Token.literal(close)))
  );
const comment = section("<!--", "-->").pipe(Parser.expected("comment"));
const declaration = section("<?", "?>").pipe(Parser.expected("processing instruction"));
const cdata = section("<![CDATA[", "]]>").pipe(Parser.expected("CDATA section"));
const doctype = section("<!", ">").pipe(Parser.expected("declaration"));
const text = Parser.map(Token.takeTill("<", { min: 1 }), unescapeXml).pipe(Parser.expected("text"));

/** Element content: text (`string`), elements, and skipped comments/PIs (`null`). */
type Node = MutableElement | string | null;
interface Content {
  readonly children: MutableElement[];
  text: string;
}

const element: Parser.Parser<MutableElement, string> = Parser.suspend(() => elementImpl);

const content: Parser.Parser<Content, string> = Parser.fold(
  Parser.alt<[
    Parser.Parser<Node>, Parser.Parser<Node>, Parser.Parser<Node>, Parser.Parser<Node>,
    Parser.Parser<Node, string>,
  ]>(
    text, cdata, Parser.as(comment, null), Parser.as(declaration, null),
    element.pipe(Parser.expected("element"))
  ),
  {
    init: (): Content => ({ children: [], text: "" }),
    f: (acc, node) => {
      if (typeof node === "string") acc.text += node;
      else if (node !== null) acc.children.push(node);
      return acc;
    },
  }
);

const closingTag = Parser.delimited(Token.literal("</"), name, Parser.seq(ws, Token.literal(">")))
  .pipe(Parser.expected("closing tag"));

/**
 * `<name attrs/>` or `<name attrs>content</name>`. Comments, declarations and
 * CDATA are tried first, so once `<` is not `</` this is committed to being an
 * element, and a mismatched closing tag is reported as such.
 */
const elementImpl: Parser.Parser<MutableElement, string> = Parser.preceded(
  // `</` is the parent's closing tag, not a child element
  Parser.seq(Token.literal("<"), Parser.not(Token.literal("/"))),
  Parser.cut(
    Parser.seq(
      name,
      attributes,
      ws,
      Parser.alt(
        Parser.as(Token.literal("/>"), null),
        Parser.preceded(Token.literal(">"), Parser.seq(content, closingTag))
      ).pipe(Parser.expected("\">\" or \"/>\""))
    ).pipe(
      Parser.filterOrFail(
        ([open, , , body]) => body === null || body[1] === open,
        ([open, , , body]) => `closing tag </${body?.[1]}> does not match <${open}>`
      ),
      Parser.map(([open, attrs, , body]): MutableElement => ({
        name: localName(open),
        attrs,
        children: body === null ? [] : body[0].children,
        text: body === null ? "" : body[0].text,
      }))
    )
  )
);

const misc = Parser.repeat(Parser.alt(ws1, comment, declaration, doctype));

/** A whole XML document: an optional BOM, prolog, one root element, trailing misc. */
const xmlDocument: Parser.Parser<XmlElement, string> = Parser.compile(
  Parser.delimited(
    Parser.seq(Parser.opt(Token.literal("\uFEFF")), misc),
    Parser.cut(element.pipe(Parser.expected("root element"))),
    Parser.cut(Parser.terminated(misc, Parser.eof))
  )
);

/**
 * Parse an XML document into its root element, or a `ParseError` that points
 * at the problem (line, column and what was expected).
 */
export const parseXmlResult = (xml: string): Result.Result<XmlElement, ParseError.ParseError<string>> =>
  Parser.parse(xmlDocument, xml);

/**
 * Parse an XML document and return its root element.
 * Throws a positioned `ParseError` on malformed input.
 */
export const parseXml = (xml: string): XmlElement => Parser.parseSync(xmlDocument, xml);

// ============================================================================
// Element queries
// ============================================================================

/** Find the first direct child with the given local name */
export const findChild = (
  element: XmlElement,
  name: string
): XmlElement | undefined => element.children.find((c) => c.name === name);

/** Find all direct children with the given local name */
export const findChildren = (
  element: XmlElement,
  name: string
): ReadonlyArray<XmlElement> => element.children.filter((c) => c.name === name);

/** Find all descendants with the given local name (depth-first) */
export const findAll = (
  element: XmlElement,
  name: string
): ReadonlyArray<XmlElement> => {
  const results: XmlElement[] = [];
  const visit = (el: XmlElement): void => {
    for (const child of el.children) {
      if (child.name === name) {
        results.push(child);
      }
      visit(child);
    }
  };
  visit(element);
  return results;
};

/** Get an attribute value, matching with or without a namespace prefix */
export const getAttr = (
  element: XmlElement,
  name: string
): string | undefined => {
  if (name in element.attrs) {
    return element.attrs[name];
  }
  // Fall back to prefix-insensitive lookup (e.g. "id" matches "r:id")
  for (const [key, value] of Object.entries(element.attrs)) {
    if (localName(key) === name) {
      return value;
    }
  }
  return undefined;
};
