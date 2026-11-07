/**
 * Minimal XML utilities shared by the OOXML formats (xlsx, docx, pptx).
 *
 * OOXML is regular, attribute-driven XML. effect-xml's strict SAX tokenizer
 * (`@thomasfosterau/effect-xml`, #141) reads it, and malformed input is
 * reported with its line and column, the tokenizer's tagged error as the
 * `ParseError`'s `cause`. The tree is built iteratively, so deep nesting
 * can't overflow the stack, and parsing never throws from `parseXmlResult`.
 *
 * Entities are never declared or expanded (a DOCTYPE's internal subset is
 * read past), so a reference to anything but XML's five predefined entities,
 * or to a character XML does not allow, fails the part. Each element's namespace is
 * resolved into `ns`, but elements are still navigated by their local names
 * (`<w:p>`, `<a:p>` and `<p:sp>` are all "p"); attribute keys keep their
 * prefixes and `getAttr` matches either. Markup Compatibility
 * `mc:AlternateContent` is resolved while parsing: an `mc:Choice` whose
 * required namespaces are understood, otherwise the `mc:Fallback`.
 */

import * as Arr from "effect/Array";
import { ParseError } from "@thomasfosterau/effect-parse";
import type { Position, SaxError } from "@thomasfosterau/effect-xml";
import * as Sax from "@thomasfosterau/effect-xml/Sax";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
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

// ---- tokenizing --------------------------------------------------------------
//
// effect-xml's strict SAX tokenizer (`Sax.forEach`, #141) reads the markup:
// names, attribute syntax, references, comments, CDATA sections, PIs and the
// DOCTYPE (its internal subset read past, never interpreted). The element
// tree is built from its events on an explicit stack, so nesting depth is
// limited by memory rather than the call stack. The structural checks
// (matched tags, one root, unique attributes) are this builder's: the
// tokenizer leaves them to a tree builder.

/**
 * The tokenizer's options. No positions per event: a failure asks for its
 * own, which costs nothing until then. No depth limit: the builder and the
 * queries are iterative, and the OPC limits already bound a part's size.
 */
const SAX_OPTIONS: Sax.ForEachOptions = {
  positions: false,
  limits: { maxDepth: Number.POSITIVE_INFINITY },
};

/** An element's attributes as they are read, and the first name given twice, if any. */
interface AttributesSoFar {
  readonly attrs: Record<string, string>;
  duplicate: string | undefined;
}

/**
 * Take one attribute into the element's: the first repeated name is kept
 * for the failure. `__proto__` is defined as an own property, as
 * `Object.fromEntries` does, never set as the prototype.
 */
const addAttribute = (acc: AttributesSoFar, name: string, value: string): void => {
  if (Object.hasOwn(acc.attrs, name)) acc.duplicate ??= name;
  else if (name === "__proto__")
    Object.defineProperty(acc.attrs, name, {
      value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  else acc.attrs[name] = value;
};

/**
 * A start tag's attributes as a record (no array of pairs per element: this
 * runs once per element of every part, bench/xlsx.bench.ts).
 */
const attributesOf = (attributes: ReadonlyArray<Sax.Attribute>): AttributesSoFar => {
  const acc: AttributesSoFar = { attrs: {}, duplicate: undefined };
  // oxlint-disable-next-line effect/imperative-loops -- once per attribute of every element: no closure or iterator per element
  for (let i = 0; i < attributes.length; i++) {
    const attribute = attributes[i]!;
    addAttribute(acc, attribute.name, attribute.value);
  }
  return acc;
};

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
  // `for…in` rather than `Object.entries`: this runs once per element, and
  // almost every element declares nothing, so nothing should be allocated
  for (const key in attrs) {
    if (key === "xmlns" || key.startsWith("xmlns:")) {
      out ??= new Map(scope);
      out.set(key === "xmlns" ? "" : key.substring(6), attrs[key] ?? "");
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

/**
 * Whether `getAttr` may need an element's scope: it does only to choose
 * between attributes that share a local name, so only for several
 * attributes, one of them prefixed (two unprefixed names never share one).
 * A cell's `<c r="A1" t="s">` needs none, and a weak map entry per cell
 * costs the collector (bench/xlsx.bench.ts).
 */
const needsScope = (attrs: Record<string, string>): boolean => {
  let n = 0;
  let prefixed = false;
  for (const key in attrs) {
    n++;
    if (!prefixed && key.includes(":")) prefixed = true;
    if (n > 1 && prefixed) return true;
  }
  return false;
};

/** Parsed elements' in-scope namespace declarations, for `getAttr`. */
const elementScopes = new WeakMap<XmlElement, Scope>();

/**
 * A tree-building failure, found as events arrive and turned into a
 * `ParseError` against the input once the whole input has tokenized (so a
 * tokenizing error later in the input still takes precedence, as when the
 * tokens were all read before the tree was built).
 */
interface Pending {
  readonly offset: number;
  readonly description: string;
  readonly expected: ReadonlyArray<string>;
}

type Failure = Pending | undefined;

const pending = (
  offset: number,
  description: string,
  expected: ReadonlyArray<string> = [],
): Pending => ({ offset, description, expected });

interface Frame {
  readonly el: MutableElement;
  readonly raw: string;
  readonly scope: Scope;
  /** Where the element's name starts, when the builder records openings (else -1). */
  readonly at: number;
}

/** Where the current event starts, in UTF-16 units of the tokenized text. */
type Locate = () => Position;

/**
 * The open elements while events arrive, built as each event is read (so no
 * event outlives its step); the first failure is kept, and later events are
 * only tokenized. `shift` is what the tokenized text lacks of the input (a
 * byte order mark), added back to every offset. With `recordOpenings`, each
 * open element keeps where its name starts, so a mismatched closing tag is
 * reported at the element it does not match; that costs a position per
 * element, so it is only done to report a mismatch found without it.
 */
class TreeBuilder {
  root: MutableElement | undefined = undefined;
  readonly stack: Frame[] = [];
  failure: Failure = undefined;
  /** Whether the first failure is a closing tag that does not match its element. */
  mismatched = false;
  readonly shift: number;
  readonly recordOpenings: boolean;

  constructor(shift: number, recordOpenings: boolean) {
    this.shift = shift;
    this.recordOpenings = recordOpenings;
  }

  /** Take one event into the tree, keeping the first failure. */
  step(event: Sax.SaxEvent, locate: Locate): void {
    if (this.failure !== undefined) return;
    // oxlint-disable-next-line effect/prefer-match-over-switch, effect/avoid-direct-tag-checks -- once per event of every part: a shared `$match` / `$is` goes megamorphic here (effect-xml's AGENTS.md: a third of the throughput), so its own lexer switches too
    switch (event._tag) {
      case "StartElement":
        this.failure = this.open(event, locate);
        break;
      case "EndElement":
        this.failure = this.close(event.name, locate);
        break;
      case "Text":
      case "CData":
        this.failure = this.text(event.data, locate);
        break;
      default:
      // comments, PIs, the declaration and the DOCTYPE are not part of the tree
    }
  }

  get top(): Frame | undefined {
    return this.stack[this.stack.length - 1];
  }

  at(locate: Locate): number {
    return locate().offset + this.shift;
  }

  text(data: string, locate: Locate): Failure {
    const top = this.top;
    if (top !== undefined) top.el.text += data;
    else if (data.trim() !== "") {
      const what = this.root === undefined ? "root element" : "end of input";
      return pending(this.at(locate), `expected ${what}`, [what]);
    }
    return undefined;
  }

  open(event: Extract<Sax.SaxEvent, { readonly _tag: "StartElement" }>, locate: Locate): Failure {
    const top = this.top;
    if (top === undefined && this.root !== undefined)
      return pending(this.at(locate), "expected end of input", ["end of input"]);
    const { attrs, duplicate } = attributesOf(event.attributes);
    if (duplicate !== undefined)
      return pending(this.at(locate), `duplicate attribute "${duplicate}"`);
    const name: string = event.name;
    const scope = withDeclarations(top?.scope ?? BASE_SCOPE, attrs);
    const el: MutableElement = {
      name: localName(name),
      ns: scope.get(prefixOf(name)) ?? "",
      attrs,
      children: [],
      text: "",
    };
    // Scopes are only consulted to disambiguate attributes and resolve
    // mc:Choice requirements, so only the elements that may need one record it.
    if (el.ns === NS_MCE || needsScope(attrs)) elementScopes.set(el, scope);
    if (top === undefined) this.root = el;
    else top.el.children.push(el);
    if (!event.selfClosing)
      this.stack.push({ el, raw: name, scope, at: this.recordOpenings ? this.at(locate) + 1 : -1 });
    else if (isAlternateContent(el) && top !== undefined) top.el.children.pop();
    return undefined;
  }

  close(name: string, locate: Locate): Failure {
    const top = this.stack.pop();
    if (top === undefined) return pending(this.at(locate), `unexpected closing tag </${name}>`);
    if (top.raw !== name) {
      this.mismatched = true;
      return pending(
        top.at === -1 ? this.at(locate) : top.at,
        `closing tag </${name}> does not match <${top.raw}>`,
      );
    }
    const parent = this.top;
    // Markup Compatibility: replace the AlternateContent with one branch.
    if (parent !== undefined && isAlternateContent(top.el)) {
      parent.el.children.pop();
      parent.el.children.push(...alternateContent(top.el, elementScopes));
    }
    return undefined;
  }

  /** The root element of `input`, or its first failure. */
  finish(input: string): Result.Result<MutableElement, ParseError.ParseError<string>> {
    const failure = this.failure;
    if (failure !== undefined)
      return Result.fail(failAt(input, failure.offset, failure.description, failure.expected));
    const open = this.top;
    if (open !== undefined)
      return Result.fail(
        failAt(input, input.length, `expected closing tag </${open.raw}>`, ["closing tag"]),
      );
    if (this.root === undefined)
      return Result.fail(failAt(input, input.length, "expected root element", ["root element"]));
    return Result.succeed(this.root);
  }
}

const isAlternateContent = (el: MutableElement): boolean =>
  el.ns === NS_MCE && el.name === "AlternateContent";

/**
 * The effect-xml error behind each tokenizing failure. `parseXmlResult`'s
 * failure type (`ParseError<string>`) is public, so the tagged error rides
 * beside it rather than in its `cause`; {@link tokenizerError} finds it.
 */
const tokenizerErrors = new WeakMap<ParseError.ParseError<string>, SaxError>();

/** The tagged effect-xml error a tokenizing failure came from, if it came from one. */
export const tokenizerError = (failure: ParseError.ParseError<string>): Option.Option<SaxError> =>
  Option.fromUndefinedOr(tokenizerErrors.get(failure));

/**
 * A tokenizing failure as a `ParseError` against the input, at the error's
 * offset (the end of the input when it has none), described by its message,
 * with the error itself kept for {@link tokenizerError}.
 */
const tokenizingFailure = (
  input: string,
  shift: number,
  error: SaxError,
): ParseError.ParseError<string> => {
  const position = "position" in error ? error.position : null;
  const failure = failAt(
    input,
    position === null ? input.length : Math.min(position.offset + shift, input.length),
    error.message,
  );
  tokenizerErrors.set(failure, error);
  return failure;
};

/**
 * Tokenize a whole document and build its tree: the root element, or the
 * first failure (a tokenizing one before a structural one). Never throws.
 */
const buildTree = (
  input: string,
  recordOpenings = false,
): Result.Result<MutableElement, ParseError.ParseError<string>> => {
  // a byte order mark belongs to the encoding, not the text: the tokenizer
  // would read it as character data before the root
  const shift = input.charCodeAt(0) === 0xfeff ? 1 : 0;
  const tree = new TreeBuilder(shift, recordOpenings);
  // oxlint-disable-next-line effect/effect-run-in-body -- `Sax.forEach` is synchronous over a string (a suspended loop) and effect-xml 0.1.0 has no Result form; the OPC reader it serves is synchronous, run inside each reader's Effect.try
  const tokenized = Effect.runSync(
    Effect.result(
      Sax.forEach(
        shift === 0 ? input : input.substring(shift),
        (event, locate) => tree.step(event, locate),
        SAX_OPTIONS,
      ),
    ),
  );
  if (Result.isFailure(tokenized))
    return Result.fail(tokenizingFailure(input, shift, tokenized.failure));
  // a mismatch is reported at the element: read again, recording openings
  return tree.mismatched && !recordOpenings ? buildTree(input, true) : tree.finish(input);
};

/**
 * Parse an XML document into its root element, or a `ParseError` that points
 * at the problem (line, column and what was expected). Never throws.
 *
 * With `fastContentOf`, the content of the first element of that name (a
 * worksheet's `sheetData`, say: nearly all of a large part) is read by a
 * scanner for simple markup (see {@link fastContent}), and the rest of the
 * document by the parser; anything the scanner does not recognise leaves the
 * whole document to the parser, so the result and every error are the
 * parser's.
 */
export const parseXmlResult = (
  xml: string,
  fastContentOf?: string,
): Result.Result<XmlElement, ParseError.ParseError<string>> =>
  Option.getOrElse(
    fastContentOf === undefined ? Option.none() : parseWithFastContent(xml, fastContentOf),
    () => buildTree(xml),
  );

// ---- the fast content scanner -----------------------------------------------

/** Whether a character may be in a name the fast scanner reads: ASCII letters and digits. */
const isFastNameCode = (c: number): boolean =>
  (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || (c >= 48 && c <= 57);

/** The end of the name at `p` the fast scanner reads (a letter, then letters and digits), or -1. */
const fastNameEnd = (xml: string, p: number): number => {
  const c = xml.charCodeAt(p);
  if (!((c >= 97 && c <= 122) || (c >= 65 && c <= 90))) return -1;
  let j = p + 1;
  // oxlint-disable-next-line effect/imperative-loops -- a character scan, once per tag of a large part (bench/xlsx.bench.ts)
  while (isFastNameCode(xml.charCodeAt(j))) j++;
  return j;
};

const isSpaceCode = (c: number): boolean => c === 32 || c === 9 || c === 10 || c === 13;

/** A start tag the fast scanner read: its attributes, the index past it, and whether it is empty. */
interface FastTag {
  readonly attrs: Record<string, string>;
  readonly end: number;
  readonly empty: boolean;
}

/**
 * The attributes of the start tag whose name ends at `p`, as the parser reads
 * them, or none for anything it must judge: a name with a prefix or other
 * characters, `xmlns`, spaces around `=`, a name given twice.
 */
const fastStartTag = (xml: string, p: number): Option.Option<FastTag> => {
  const attrs: Record<string, string> = {};
  let j = p;
  // oxlint-disable-next-line effect/imperative-loops -- once per attribute of a tag of a large part
  for (;;) {
    const spaced = j;
    // oxlint-disable-next-line effect/imperative-loops -- a character scan over whitespace
    while (isSpaceCode(xml.charCodeAt(j))) j++;
    const c = xml.charCodeAt(j);
    if (c === 62) return Option.some({ attrs, end: j + 1, empty: false });
    if (c === 47)
      return xml.charCodeAt(j + 1) === 62
        ? Option.some({ attrs, end: j + 2, empty: true })
        : Option.none();
    j = j === spaced ? -1 : fastAttribute(xml, j, attrs);
    if (j === -1) return Option.none();
  }
};

/**
 * Read the attribute `name="value"` at `j` into `attrs`: the index past it,
 * or -1 for anything {@link fastStartTag} leaves to the parser.
 */
const fastAttribute = (xml: string, j: number, attrs: Record<string, string>): number => {
  const nameEnd = fastNameEnd(xml, j);
  const quote = xml.charCodeAt(nameEnd + 1);
  if (nameEnd === -1 || xml.charCodeAt(nameEnd) !== 61 || (quote !== 34 && quote !== 39)) return -1;
  const close = xml.indexOf(quote === 34 ? '"' : "'", nameEnd + 2);
  const name = xml.slice(j, nameEnd);
  if (
    close === -1 ||
    name === "xmlns" ||
    Object.hasOwn(attrs, name) ||
    !isPlainValue(xml, nameEnd + 2, close)
  )
    return -1;
  attrs[name] = unescapeXml(xml.slice(nameEnd + 2, close));
  return close + 1;
};

/** The fast scan's open elements, the outermost first. */
interface FastScan {
  readonly stack: Array<MutableElement>;
  p: number;
}

/**
 * Take the markup at `lt` (a `<`) into the scan: a closing tag closes the
 * open element it names, a start tag opens (or, empty, adds) a child of it.
 * False for markup the scanner leaves to the parser: a comment, CDATA, a
 * processing instruction, a prefixed or unusual name, a mismatched tag.
 */
const fastTag = (xml: string, lt: number, scan: FastScan, ns: string): boolean => {
  const top = scan.stack.at(-1);
  if (top === undefined) return false;
  if (xml.charCodeAt(lt + 1) === 47) {
    const nameEnd = fastNameEnd(xml, lt + 2);
    if (nameEnd === -1 || xml.charCodeAt(nameEnd) !== 62) return false;
    if (xml.slice(lt + 2, nameEnd) !== top.name) return false;
    scan.stack.pop();
    scan.p = nameEnd + 1;
    return true;
  }
  const nameEnd = fastNameEnd(xml, lt + 1);
  const tag = nameEnd === -1 ? Option.none<FastTag>() : fastStartTag(xml, nameEnd);
  if (Option.isNone(tag)) return false;
  const el: MutableElement = {
    name: xml.slice(lt + 1, nameEnd),
    ns,
    attrs: tag.value.attrs,
    children: [],
    text: "",
  };
  top.children.push(el);
  if (!tag.value.empty) scan.stack.push(el);
  scan.p = tag.value.end;
  return true;
};

/**
 * The content of `outer` from `from` to its closing tag, read by a scanner
 * for simple markup: elements with plain names (no prefix) in `outer`'s
 * namespace, attributes with plain names, and text, as the parser would build
 * them. None at anything else, for the parser to judge. The index past the
 * closing tag when it succeeds.
 */
const fastContent = (xml: string, from: number, outer: MutableElement): Option.Option<number> => {
  const scan: FastScan = { stack: [outer], p: from };
  // oxlint-disable-next-line effect/imperative-loops -- once per tag of a large part (bench/xlsx.bench.ts)
  while (Arr.isReadonlyArrayNonEmpty(scan.stack)) {
    const lt = xml.indexOf("<", scan.p);
    const top = scan.stack.at(-1);
    if (lt === -1 || top === undefined) return Option.none();
    if (lt > scan.p) top.text += unescapeXml(xml.slice(scan.p, lt));
    if (!fastTag(xml, lt, scan, outer.ns)) return Option.none();
  }
  return Option.some(scan.p);
};

/**
 * {@link parseXmlResult} with the content of the first `<name>` element read
 * by {@link fastContent}: the parser reads the document with that content cut
 * out (so the rest is checked as before), and the scanned content is put back
 * into its element. None when the scanner cannot read it, or the cut document
 * does not parse, for the parser to read the whole document instead.
 */
const parseWithFastContent = (
  xml: string,
  name: string,
): Option.Option<Result.Result<XmlElement, ParseError.ParseError<string>>> =>
  Option.map(
    cutAndParse(xml, name, (source, from) => {
      const outer: MutableElement = { name, ns: "", attrs: {}, children: [], text: "" };
      return Option.map(fastContent(source, from, outer), (end) => ({ end, value: outer }));
    }),
    ({ root, target, value: outer }) => {
      setNamespace(outer.children, target.ns);
      target.children = outer.children;
      target.text = outer.text;
      return Result.succeed(root);
    },
  );

/** A content scanner's reading of an element's content: the index past its closing tag, and what it read. */
export interface ScannedContent<A> {
  readonly end: number;
  readonly value: A;
}

/** A document read with one element's content cut out, that element (left empty), and what the scanner read of its content. */
export interface ParsedWithScan<A> {
  readonly root: XmlElement;
  readonly target: XmlElement;
  readonly value: A;
}

/**
 * Read a document whose first `<name>` element's content is read by `scan`
 * (from the index past its start tag to the index past its closing tag), and
 * the rest by the parser, with that content cut out. The cut element comes
 * back empty, beside what `scan` read; a caller checks it is where it expects
 * the content (a direct child of the root, say). None when there is no such
 * element, a comment, CDATA or declaration comes before it, `scan` gives up,
 * or the cut document does not parse, for the caller to parse the whole
 * document instead (so every tree and error is the parser's).
 */
export const parseWithScannedContent: <A>(
  xml: string,
  name: string,
  scan: (xml: string, from: number) => Option.Option<ScannedContent<A>>,
) => Option.Option<ParsedWithScan<A>> = (xml, name, scan) => cutAndParse(xml, name, scan);

/**
 * What the content scanners do not model of the strict tokenizer (#141),
 * checked once over the content rather than per value (the scanners run once
 * per cell): a character XML forbids or a carriage return (line ends are
 * normalized; {@link CONTROL}), `]]>` in text, and a reference other than the
 * five predefined entities and numeric character references to characters
 * XML allows ({@link BAD_REFERENCE}, {@link forbiddenCharRef}). Attribute
 * values are checked by the scanners as they read them
 * ({@link isPlainValue}). Content with any of them is left to the tree path,
 * so its tree and errors are the tokenizer's.
 */
// oxlint-disable-next-line no-control-regex -- the control characters XML forbids are exactly what it looks for
const CONTROL = /[\0-\x08\x0B\x0C\x0E-\x1F\r\uFFFE\uFFFF]/g;

/** A reference the tokenizer does not take as it is: an unknown entity, or no reference at all. */
const BAD_REFERENCE = /&(?!(?:lt|gt|amp|quot|apos|#[0-9]+|#x[0-9a-fA-F]+);)/g;

/** A numeric character reference, its digits captured (`x` first for hexadecimal). */
const CHAR_REF = /&#(x?)([0-9a-fA-F]+);/g;

/** Whether `code` is a character XML 1.0 allows (its `Char` production). */
const isXmlChar = (code: number): boolean =>
  code === 0x9 ||
  code === 0xa ||
  code === 0xd ||
  (code >= 0x20 && code <= 0xd7ff) ||
  (code >= 0xe000 && code <= 0xfffd) ||
  (code >= 0x10000 && code <= 0x10ffff);

/** Whether `content` holds a character reference to a character XML forbids. */
const forbiddenCharRef = (content: string): boolean =>
  content.includes("&#") &&
  Arr.some([...content.matchAll(CHAR_REF)], ([, hex, digits]) => {
    const code = Number.parseInt(digits ?? "", hex === "x" ? 16 : 10);
    return !isXmlChar(code);
  });

/**
 * Whether `pattern` matches between `from` and `end`: run on the whole text
 * from `from` (a slice of a large part could be flattened into a copy), the
 * match bounded by `end`.
 */
const matchesWithin = (pattern: RegExp, xml: string, from: number, end: number): boolean => {
  const sticky = new RegExp(pattern.source, "g");
  sticky.lastIndex = from;
  const found = sticky.exec(xml);
  return found !== null && found.index < end;
};

/** Whether `needle` occurs between `from` and `end`. */
const occursWithin = (needle: string, xml: string, from: number, end: number): boolean => {
  const at = xml.indexOf(needle, from);
  return at !== -1 && at + needle.length <= end;
};

/** Whether the content from `from` to `end` holds anything the scanners do not model. */
const hasUnmodelled = (xml: string, from: number, end: number): boolean =>
  matchesWithin(CONTROL, xml, from, end) ||
  occursWithin("]]>", xml, from, end) ||
  (occursWithin("&", xml, from, end) &&
    (matchesWithin(BAD_REFERENCE, xml, from, end) || forbiddenCharRef(xml.slice(from, end))));

/**
 * Whether the attribute value from `start` to `end` is read by the strict
 * tokenizer as written: no `<` (forbidden) and no tab or line feed (which it
 * normalizes to a space; a carriage return is caught by {@link CONTROL}).
 */
export const isPlainValue = (xml: string, start: number, end: number): boolean => {
  // oxlint-disable-next-line effect/imperative-loops -- a character scan over one short value, once per attribute of a large part
  for (let i = start; i < end; i++) {
    const c = xml.charCodeAt(i);
    if (c === 60 || c === 9 || c === 10) return false;
  }
  return true;
};

/** {@link parseWithScannedContent}, giving the cut element as the mutable element it is. */
const cutAndParse = <A>(
  xml: string,
  name: string,
  scan: (xml: string, from: number) => Option.Option<ScannedContent<A>>,
): Option.Option<{
  readonly root: XmlElement;
  readonly target: MutableElement;
  readonly value: A;
}> => {
  const start = xml.indexOf(`<${name}`);
  // a comment, CDATA or declaration before it could hide or fake the tag
  if (start === -1 || xml.lastIndexOf("<!", start) !== -1) return Option.none();
  const tag = fastStartTag(xml, start + 1 + name.length);
  if (Option.isNone(tag) || tag.value.empty) return Option.none();
  const scanned = scan(xml, tag.value.end);
  if (Option.isNone(scanned) || hasUnmodelled(xml, tag.value.end, scanned.value.end))
    return Option.none();
  const closeStart = scanned.value.end - name.length - 3;
  const tree = buildTree(xml.slice(0, tag.value.end) + xml.slice(closeStart));
  if (Result.isFailure(tree)) return Option.none();
  const root = tree.success;
  const found = firstNamed(root, name);
  if (Option.isNone(found)) return Option.none();
  const target = found.value;
  // the cut element must be the one scanned: in the namespace the scan gave
  // its children, and still empty
  if (target.ns === NS_MCE || Arr.isReadonlyArrayNonEmpty(target.children) || target.text !== "")
    return Option.none();
  return Option.some({ root, target, value: scanned.value.value });
};

/** Give scanned elements, and every element within them, the namespace `ns`. */
const setNamespace = (elements: ReadonlyArray<MutableElement>, ns: string): void => {
  const todo = [...elements];
  // oxlint-disable-next-line effect/imperative-loops -- an explicit-stack walk: a deep tree stays off the call stack
  for (let el = todo.pop(); el !== undefined; el = todo.pop()) {
    el.ns = ns;
    todo.push(...el.children);
  }
};

/** The first element named `name` in document order (a pre-order walk, without recursion). */
const firstNamed = (root: MutableElement, name: string): Option.Option<MutableElement> => {
  const todo: Array<MutableElement> = [root];
  // oxlint-disable-next-line effect/imperative-loops -- an explicit-stack walk: a deep tree stays off the call stack
  for (let el = todo.pop(); el !== undefined; el = todo.pop()) {
    if (el.name === name) return Option.some(el);
    // children pushed last first, so the walk is in document order
    todo.push(...Arr.reverse(el.children));
  }
  return Option.none();
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
  const stack: XmlElement[] = element.children.toReversed();
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
  return Arr.isReadonlyArrayNonEmpty(matches) ? element.attrs[matches[0]] : undefined;
};
