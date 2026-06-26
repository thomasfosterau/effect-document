/**
 * Minimal XML utilities for SpreadsheetML.
 *
 * SpreadsheetML is regular, attribute-driven XML; a purpose-built scanner
 * keeps this package dependency-free beyond fflate. This is not a general
 * XML parser - it handles the subset OOXML spreadsheets use (elements,
 * attributes, text content, self-closing tags, declarations, comments).
 */

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

const ATTR_PATTERN = /([^\s=]+)\s*=\s*"([^"]*)"|([^\s=]+)\s*=\s*'([^']*)'/g;

const parseAttrs = (raw: string): Record<string, string> => {
  const attrs: Record<string, string> = {};
  for (const match of raw.matchAll(ATTR_PATTERN)) {
    const key = match[1] ?? match[3];
    const value = match[2] ?? match[4];
    if (key !== undefined && value !== undefined) {
      attrs[key] = unescapeXml(value);
    }
  }
  return attrs;
};

/**
 * Parse an XML document and return its root element.
 * Throws on malformed input.
 */
export const parseXml = (xml: string): XmlElement => {
  const root: MutableElement = { name: "#root", attrs: {}, children: [], text: "" };
  const stack: MutableElement[] = [root];

  let position = 0;
  while (position < xml.length) {
    const tagStart = xml.indexOf("<", position);

    if (tagStart === -1) {
      // Trailing text after the last tag
      const current = stack[stack.length - 1]!;
      current.text += unescapeXml(xml.substring(position));
      break;
    }

    // Text content before this tag
    if (tagStart > position) {
      const current = stack[stack.length - 1]!;
      current.text += unescapeXml(xml.substring(position, tagStart));
    }

    // Declarations: <?...?>
    if (xml.startsWith("<?", tagStart)) {
      const end = xml.indexOf("?>", tagStart);
      if (end === -1) {
        throw new Error("Malformed XML: unterminated declaration");
      }
      position = end + 2;
      continue;
    }

    // Comments: <!--...-->
    if (xml.startsWith("<!--", tagStart)) {
      const end = xml.indexOf("-->", tagStart);
      if (end === -1) {
        throw new Error("Malformed XML: unterminated comment");
      }
      position = end + 3;
      continue;
    }

    // Other declarations: <!DOCTYPE ...>, <![CDATA[...]]>
    if (xml.startsWith("<!", tagStart)) {
      if (xml.startsWith("<![CDATA[", tagStart)) {
        const end = xml.indexOf("]]>", tagStart);
        if (end === -1) {
          throw new Error("Malformed XML: unterminated CDATA section");
        }
        const current = stack[stack.length - 1]!;
        current.text += xml.substring(tagStart + 9, end);
        position = end + 3;
        continue;
      }
      const end = xml.indexOf(">", tagStart);
      if (end === -1) {
        throw new Error("Malformed XML: unterminated declaration");
      }
      position = end + 1;
      continue;
    }

    const tagEnd = xml.indexOf(">", tagStart);
    if (tagEnd === -1) {
      throw new Error("Malformed XML: unterminated tag");
    }
    const rawTag = xml.substring(tagStart + 1, tagEnd);
    position = tagEnd + 1;

    // Closing tag: </name>
    if (rawTag.startsWith("/")) {
      if (stack.length <= 1) {
        throw new Error(`Malformed XML: unexpected closing tag </${rawTag.substring(1)}>`);
      }
      stack.pop();
      continue;
    }

    // Opening or self-closing tag
    const selfClosing = rawTag.endsWith("/");
    const tagBody = selfClosing ? rawTag.slice(0, -1) : rawTag;
    const spaceIdx = tagBody.search(/[\s]/);
    const name = spaceIdx === -1 ? tagBody : tagBody.substring(0, spaceIdx);
    const attrsRaw = spaceIdx === -1 ? "" : tagBody.substring(spaceIdx);

    const element: MutableElement = {
      name: localName(name),
      attrs: parseAttrs(attrsRaw),
      children: [],
      text: "",
    };

    const parent = stack[stack.length - 1]!;
    parent.children.push(element);

    if (!selfClosing) {
      stack.push(element);
    }
  }

  const rootChild = root.children[0];
  if (rootChild === undefined) {
    throw new Error("Malformed XML: no root element");
  }
  return rootChild;
};

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
