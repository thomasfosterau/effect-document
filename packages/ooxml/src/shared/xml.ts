/**
 * Minimal XML utilities shared by the OOXML formats (xlsx, docx, pptx).
 *
 * OOXML is regular, attribute-driven XML; a small effect-parse grammar handles
 * the subset OOXML uses (elements, attributes, text content, self-closing
 * tags, declarations, comments, CDATA) and reports malformed input with its
 * line and column. The tree is built iteratively, so deep nesting can't
 * overflow the stack, and parsing never throws from `parseXmlResult`.
 *
 * This is not a general XML parser: entities are never declared or expanded
 * (a DOCTYPE's internal subset is skipped). Each element's namespace is
 * resolved into `ns`, but elements are still navigated by their local names
 * (`<w:p>`, `<a:p>` and `<p:sp>` are all "p"); attribute keys keep their
 * prefixes and `getAttr` matches either. Markup Compatibility
 * `mc:AlternateContent` is resolved while parsing: an `mc:Choice` whose
 * required namespaces are understood, otherwise the `mc:Fallback`.
 */

import * as Arr from "effect/Array";
import { ParseError, Parser, Token } from "@thomasfosterau/effect-parse";
import * as Result from "effect/Result";

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

/** A character reference's code point, or U+FFFD if it isn't a valid one. */
const charRef = (code: number): string =>
  Number.isInteger(code) && code >= 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff)
    ? String.fromCodePoint(code)
    : "�";

/** Unescape XML text content and attribute values */
export const unescapeXml = (s: string): string =>
  s.includes("&")
    ? s.replace(/&(#x[0-9a-fA-F]+|#\d+|lt|gt|quot|apos|amp);/g, (whole, ref: string) => {
        if (ref === "lt") {
          return "<";
        } else if (ref === "gt") {
          return ">";
        } else if (ref === "quot") {
          return '"';
        } else if (ref === "apos") {
          return "'";
        } else if (ref === "amp") {
          return "&";
        } else {
          return charRef(
            ref[1] === "x"
              ? Number.parseInt(ref.substring(2), 16)
              : Number.parseInt(ref.substring(1), 10),
          );
        }
      })
    : s;

// ============================================================================
// Parsing
// ============================================================================

/** A parsed XML element */
export interface XmlElement {
  /** Local element name (namespace prefix stripped) */
  readonly name: string;
  /** The element's resolved namespace URI ("" when it has none). */
  readonly ns: string;
  /** Attributes (keys keep their prefixes, e.g. "r:id") */
  readonly attrs: Readonly<Record<string, string>>;
  readonly children: ReadonlyArray<XmlElement>;
  /** Concatenated direct text content */
  readonly text: string;
}

interface MutableElement {
  name: string;
  ns: string;
  attrs: Record<string, string>;
  children: MutableElement[];
  text: string;
}

const prefixOf = (name: string): string => {
  const colon = name.indexOf(":");
  return colon === -1 ? "" : name.substring(0, colon);
};

const localName = (name: string): string => {
  const colon = name.indexOf(":");
  return colon === -1 ? name : name.substring(colon + 1);
};

// ---- grammar ---------------------------------------------------------------
//
// The grammar only tokenizes (tags, text, CDATA, comments, declarations); the
// element tree is built from the tokens on an explicit stack, so nesting depth
// is limited by memory rather than the call stack.

const space = " \t\r\n";
const ws = Token.takeWhile(space);
const ws1 = Token.takeWhile(space, { min: 1 });

const isNameStartCode = (c: number): boolean =>
  (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || c === 95 || c === 58 || c >= 0xc0;
const isNameStart = (ch: string): boolean => isNameStartCode(ch.charCodeAt(0));
const isNameChar = (ch: string): boolean => {
  const c = ch.charCodeAt(0);
  return isNameStartCode(c) || (c >= 48 && c <= 57) || c === 45 || c === 46 || c === 0xb7;
};
const name = Token.takeWhile(isNameChar, { min: 1 }).pipe(
  Parser.filter((n) => isNameStart(n[0]!)),
  Parser.expected("name"),
);

const quoted = (quote: string) =>
  Parser.preceded(
    Token.literal(quote),
    Parser.cut(Parser.terminated(Token.takeTill(quote), Token.literal(quote))),
  );
const attribute = Parser.separatedPair(
  name,
  Parser.seq(ws, Token.literal("="), ws),
  Parser.map(Parser.alt(quoted('"'), quoted("'")), unescapeXml).pipe(
    Parser.expected("attribute value"),
  ),
);
const attributes = Parser.repeat(Parser.preceded(ws1, attribute)).pipe(
  Parser.filterOrFail(
    (pairs) => new Set(pairs.map(([k]) => k)).size === pairs.length,
    (pairs) =>
      `duplicate attribute "${pairs.find(([k], i) => pairs.findIndex(([j]) => j === k) !== i)?.[0]}"`,
  ),
  // SAFETY: every pair is a [name, value] of strings, so the entries make a string record
  Parser.map((pairs) => Object.fromEntries(pairs) as Record<string, string>),
);

/** `open ... close`, committed once `open` has matched. */
const section = (open: string, close: string) =>
  Parser.preceded(
    Token.literal(open),
    Parser.cut(Parser.terminated(Token.takeUntil(close), Token.literal(close))),
  );
const comment = section("<!--", "-->").pipe(Parser.expected("comment"));
const declaration = section("<?", "?>").pipe(Parser.expected("processing instruction"));
const cdata = section("<![CDATA[", "]]>").pipe(Parser.expected("CDATA section"));
/** `<!DOCTYPE ...>`, including an internal subset `[...]`; entities are never expanded. */
const doctype = Parser.preceded(
  Token.literal("<!"),
  Parser.cut(
    Parser.seq(Token.takeTill("[>"), Parser.opt(section("[", "]")), ws, Token.literal(">")),
  ),
).pipe(Parser.expected("declaration"));
const text = Parser.map(Token.takeTill("<", { min: 1 }), unescapeXml).pipe(Parser.expected("text"));

type XmlToken =
  | {
      readonly k: "open";
      readonly name: string;
      readonly attrs: Record<string, string>;
      readonly empty: boolean;
      readonly at: number;
    }
  | { readonly k: "close"; readonly name: string; readonly at: number }
  | { readonly k: "text"; readonly text: string; readonly at: number }
  | null;

const openTag: Parser.Parser<XmlToken, string> = Parser.preceded(
  // `</`, `<!` and `<?` are closing tags, comments/CDATA/DOCTYPE and PIs
  Parser.seq(Token.literal("<"), Parser.not(Token.oneOf("/!?"))),
  Parser.cut(
    Parser.map(
      Parser.seq(
        Parser.location,
        name,
        attributes,
        ws,
        Parser.alt(Parser.as(Token.literal("/>"), true), Parser.as(Token.literal(">"), false)).pipe(
          Parser.expected('">" or "/>"'),
        ),
      ),
      ([at, tag, attrs, , empty]): XmlToken => ({ k: "open", name: tag, attrs, empty, at }),
    ),
  ),
);

const closeTag: Parser.Parser<XmlToken> = Parser.map(
  Parser.seq(
    Parser.location,
    Parser.delimited(
      Token.literal("</"),
      Parser.cut(name),
      Parser.cut(Parser.seq(ws, Token.literal(">"))),
    ),
  ),
  ([at, tag]): XmlToken => ({ k: "close", name: tag, at: at + 2 }),
).pipe(Parser.expected("closing tag"));

const textToken: Parser.Parser<XmlToken> = Parser.map(
  Parser.seq(Parser.location, text),
  ([at, t]): XmlToken => ({ k: "text", text: t, at }),
);

const cdataToken: Parser.Parser<XmlToken> = Parser.map(
  Parser.seq(Parser.location, cdata),
  ([at, t]): XmlToken => ({ k: "text", text: t, at }),
);

const xmlToken: Parser.Parser<XmlToken, string> = Parser.alt<
  [
    Parser.Parser<XmlToken>,
    Parser.Parser<XmlToken, string>,
    Parser.Parser<XmlToken>,
    Parser.Parser<XmlToken>,
    Parser.Parser<XmlToken>,
    Parser.Parser<XmlToken>,
    Parser.Parser<XmlToken>,
  ]
>(
  // most frequent first; the `<!`/`<?` forms are only tried after `<name`
  // and `</name` have been ruled out by their first characters
  textToken,
  openTag.pipe(Parser.expected("element")),
  closeTag,
  cdataToken,
  Parser.as(comment, null),
  Parser.as(declaration, null),
  Parser.as(doctype, null),
);

/** A whole XML document as tokens: an optional BOM, then tokens to the end. */
const xmlTokens: Parser.Parser<ReadonlyArray<XmlToken>, string> = Parser.compile(
  Parser.delimited(Parser.opt(Token.literal("﻿")), Parser.repeat(xmlToken), Parser.cut(Parser.eof)),
);

// ---- tree building ---------------------------------------------------------

const NS_XML = "http://www.w3.org/XML/1998/namespace";
const NS_MCE = "http://schemas.openxmlformats.org/markup-compatibility/2006";

/**
 * Namespaces whose content these readers understand, for choosing an
 * `mc:Choice` (Markup Compatibility): the Transitional and Strict OOXML
 * vocabularies the readers navigate. Extension namespaces (w14, a14, wps,
 * x14, p14, ...) are not, so their `mc:Fallback` is used instead.
 */
const UNDERSTOOD_NAMESPACES: ReadonlySet<string> = new Set([
  "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
  "http://schemas.openxmlformats.org/spreadsheetml/2006/main",
  "http://schemas.openxmlformats.org/presentationml/2006/main",
  "http://schemas.openxmlformats.org/drawingml/2006/main",
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
  "http://purl.oclc.org/ooxml/wordprocessingml/main",
  "http://purl.oclc.org/ooxml/spreadsheetml/main",
  "http://purl.oclc.org/ooxml/presentationml/main",
  "http://purl.oclc.org/ooxml/drawingml/main",
  "http://purl.oclc.org/ooxml/officeDocument/relationships",
]);

type Scope = ReadonlyMap<string, string>;

const BASE_SCOPE: Scope = new Map([["xml", NS_XML]]);

/** Extend `scope` with the element's `xmlns`/`xmlns:p` declarations. */
const withDeclarations = (scope: Scope, attrs: Record<string, string>): Scope => {
  let out: Map<string, string> | undefined;
  for (const [key, value] of Object.entries(attrs)) {
    if (key === "xmlns" || key.startsWith("xmlns:")) {
      out ??= new Map(scope);
      out.set(key === "xmlns" ? "" : key.substring(6), value);
    }
  }
  return out ?? scope;
};

/** The children an `mc:AlternateContent` stands for: an understood Choice, else the Fallback. */
const alternateContent = (
  el: MutableElement,
  scopes: WeakMap<XmlElement, Scope>,
): MutableElement[] => {
  for (const branch of el.children) {
    if (branch.ns !== NS_MCE) continue;
    if (branch.name === "Fallback") return branch.children;
    if (branch.name === "Choice") {
      const scope = scopes.get(branch) ?? BASE_SCOPE;
      const requires = (branch.attrs["Requires"] ?? "").split(/\s+/).filter((p) => p !== "");
      if (requires.every((p) => UNDERSTOOD_NAMESPACES.has(scope.get(p) ?? "")))
        return branch.children;
    }
  }
  return [];
};

const failAt = (
  input: string,
  offset: number,
  description: string,
  expected: ReadonlyArray<string> = [],
) =>
  new ParseError.ParseError<string>({
    input,
    offset,
    kind: "Verify",
    mode: "Cut",
    expected,
    context: [],
    cause: undefined,
    description,
  });

const hasSeveralAttrs = (attrs: Record<string, string>): boolean => {
  let n = 0;
  for (const _ in attrs) if (++n > 1) return true;
  return false;
};

/** Parsed elements' in-scope namespace declarations, for `getAttr`. */
const elementScopes = new WeakMap<XmlElement, Scope>();

type TokenOf<K extends string> = Extract<NonNullable<XmlToken>, { readonly k: K }>;
type Failure = ParseError.ParseError<string> | undefined;

interface Frame {
  readonly el: MutableElement;
  readonly raw: string;
  readonly at: number;
  readonly scope: Scope;
}

/** The open elements while tokens arrive; each step returns the failure it hits, if any. */
class TreeBuilder {
  readonly input: string;
  root: MutableElement | undefined = undefined;
  readonly stack: Frame[] = [];

  constructor(input: string) {
    this.input = input;
  }

  get top(): Frame | undefined {
    return this.stack[this.stack.length - 1];
  }

  text(token: TokenOf<"text">): Failure {
    const top = this.top;
    if (top !== undefined) top.el.text += token.text;
    else if (token.text.trim() !== "") {
      const what = this.root === undefined ? "root element" : "end of input";
      return failAt(this.input, token.at, `expected ${what}`, [what]);
    }
    return undefined;
  }

  open(token: TokenOf<"open">): Failure {
    const top = this.top;
    if (top === undefined && this.root !== undefined)
      return failAt(this.input, token.at - 1, "expected end of input", ["end of input"]);
    const scope = withDeclarations(top?.scope ?? BASE_SCOPE, token.attrs);
    const el: MutableElement = {
      name: localName(token.name),
      ns: scope.get(prefixOf(token.name)) ?? "",
      attrs: token.attrs,
      children: [],
      text: "",
    };
    // Scopes are only consulted to disambiguate attributes and resolve
    // mc:Choice requirements, so only those elements record one.
    if (el.ns === NS_MCE || hasSeveralAttrs(token.attrs)) elementScopes.set(el, scope);
    if (top === undefined) this.root = el;
    else top.el.children.push(el);
    if (!token.empty) this.stack.push({ el, raw: token.name, at: token.at, scope });
    else if (isAlternateContent(el) && top !== undefined) top.el.children.pop();
    return undefined;
  }

  close(token: TokenOf<"close">): Failure {
    const top = this.stack.pop();
    if (top === undefined)
      return failAt(this.input, token.at, `unexpected closing tag </${token.name}>`);
    if (top.raw !== token.name)
      return failAt(this.input, top.at, `closing tag </${token.name}> does not match <${top.raw}>`);
    const parent = this.top;
    // Markup Compatibility: replace the AlternateContent with one branch.
    if (parent !== undefined && isAlternateContent(top.el)) {
      parent.el.children.pop();
      parent.el.children.push(...alternateContent(top.el, elementScopes));
    }
    return undefined;
  }

  finish(): Result.Result<XmlElement, ParseError.ParseError<string>> {
    const open = this.top;
    if (open !== undefined)
      return Result.fail(
        failAt(this.input, this.input.length, `expected closing tag </${open.raw}>`, [
          "closing tag",
        ]),
      );
    if (this.root === undefined)
      return Result.fail(
        failAt(this.input, this.input.length, "expected root element", ["root element"]),
      );
    return Result.succeed(this.root);
  }
}

const isAlternateContent = (el: MutableElement): boolean =>
  el.ns === NS_MCE && el.name === "AlternateContent";

const buildTree = (
  input: string,
  tokens: ReadonlyArray<XmlToken>,
): Result.Result<XmlElement, ParseError.ParseError<string>> => {
  const tree = new TreeBuilder(input);
  for (const token of tokens) {
    if (token === null) continue;
    const failure =
      token.k === "text"
        ? tree.text(token)
        : token.k === "open"
          ? tree.open(token)
          : tree.close(token);
    if (failure !== undefined) return Result.fail(failure);
  }
  return tree.finish();
};

/**
 * Parse an XML document into its root element, or a `ParseError` that points
 * at the problem (line, column and what was expected). Never throws.
 */
export const parseXmlResult = (
  xml: string,
): Result.Result<XmlElement, ParseError.ParseError<string>> => {
  const tokens = Parser.parse(xmlTokens, xml);
  return Result.isSuccess(tokens) ? buildTree(xml, tokens.success) : Result.fail(tokens.failure);
};

/**
 * Parse an XML document and return its root element.
 * Throws a positioned `ParseError` on malformed input.
 */
export const parseXml = (xml: string): XmlElement => {
  const result = parseXmlResult(xml);
  if (Result.isSuccess(result)) return result.success;
  throw result.failure;
};

// ============================================================================
// Element queries
// ============================================================================

/** Find the first direct child with the given local name */
export const findChild = (element: XmlElement, name: string): XmlElement | undefined =>
  element.children.find((c) => c.name === name);

/** Find all direct children with the given local name */
export const findChildren = (element: XmlElement, name: string): ReadonlyArray<XmlElement> =>
  element.children.filter((c) => c.name === name);

/** Find all descendants with the given local name (depth-first, document order) */
export const findAll = (element: XmlElement, name: string): ReadonlyArray<XmlElement> => {
  const results: XmlElement[] = [];
  const stack: XmlElement[] = [...element.children].reverse();
  while (Arr.isReadonlyArrayNonEmpty(stack)) {
    const el = stack.pop()!;
    if (el.name === name) results.push(el);
    for (let n = el.children.length - 1; n >= 0; n--) stack.push(el.children[n]!);
  }
  return results;
};

/**
 * Get an attribute value, matching with or without a namespace prefix. When
 * several prefixed attributes share the local name (`w:val` and `w14:val`),
 * the one in the element's own namespace wins.
 */
export const getAttr = (element: XmlElement, name: string): string | undefined => {
  if (name in element.attrs) {
    return element.attrs[name];
  }
  // Fall back to prefix-insensitive lookup (e.g. "id" matches "r:id")
  const matches = Object.keys(element.attrs).filter((key) => localName(key) === name);
  if (matches.length > 1) {
    const scope = elementScopes.get(element);
    const own = matches.find((key) => scope?.get(prefixOf(key)) === element.ns);
    if (own !== undefined) return element.attrs[own];
  }
  return Arr.isReadonlyArrayNonEmpty(matches) ? element.attrs[matches[0]!] : undefined;
};
