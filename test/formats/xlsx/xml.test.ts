/**
 * Tests for the minimal XML utilities
 */

import { describe, expect, test } from "bun:test";
import {
  escapeAttr,
  escapeXml,
  findAll,
  findChild,
  findChildren,
  getAttr,
  parseXml,
  unescapeXml,
} from "../../../src/formats/xlsx/index.js";

describe("escaping", () => {
  test("escapes text content", () => {
    expect(escapeXml("a < b & c > d")).toBe("a &lt; b &amp; c &gt; d");
  });

  test("escapes attribute values", () => {
    expect(escapeAttr('say "hi" & <bye>')).toBe(
      "say &quot;hi&quot; &amp; &lt;bye&gt;"
    );
    expect(escapeAttr("tab\there")).toBe("tab&#9;here");
  });

  test("unescapes entities", () => {
    expect(unescapeXml("a &lt; b &amp; c &gt; d")).toBe("a < b & c > d");
    expect(unescapeXml("&quot;quoted&quot; &apos;single&apos;")).toBe(
      "\"quoted\" 'single'"
    );
    expect(unescapeXml("&#65;&#x42;")).toBe("AB");
  });

  test("escape/unescape round-trips", () => {
    const tricky = 'a < b & "c" > \'d\' &amp; <tag/>';
    expect(unescapeXml(escapeXml(tricky))).toBe(tricky);
    expect(unescapeXml(escapeAttr(tricky))).toBe(tricky);
  });
});

describe("parseXml", () => {
  test("parses a simple document", () => {
    const root = parseXml(
      '<?xml version="1.0"?><root attr="value"><child>text</child></root>'
    );

    expect(root.name).toBe("root");
    expect(root.attrs["attr"]).toBe("value");
    expect(root.children.length).toBe(1);
    expect(root.children[0]?.name).toBe("child");
    expect(root.children[0]?.text).toBe("text");
  });

  test("parses self-closing tags", () => {
    const root = parseXml('<row><c r="A1"/><c r="B1"/></row>');

    expect(root.children.length).toBe(2);
    expect(root.children[0]?.attrs["r"]).toBe("A1");
    expect(root.children[1]?.attrs["r"]).toBe("B1");
  });

  test("strips namespace prefixes from element names but keeps attribute keys", () => {
    const root = parseXml(
      '<x:sheet xmlns:x="ns" name="Data" r:id="rId1"></x:sheet>'
    );

    expect(root.name).toBe("sheet");
    expect(root.attrs["name"]).toBe("Data");
    expect(root.attrs["r:id"]).toBe("rId1");
  });

  test("unescapes text and attribute content", () => {
    const root = parseXml('<t a="&quot;x&quot;">a &amp; b</t>');

    expect(root.text).toBe("a & b");
    expect(root.attrs["a"]).toBe('"x"');
  });

  test("handles nested SpreadsheetML structures", () => {
    const root = parseXml(
      "<worksheet><sheetData>" +
        '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1"><v>42</v></c></row>' +
        '<row r="2"><c r="A2" t="inlineStr"><is><t>inline</t></is></c></row>' +
        "</sheetData></worksheet>"
    );

    const sheetData = findChild(root, "sheetData");
    expect(sheetData).toBeDefined();
    const rows = findChildren(sheetData!, "row");
    expect(rows.length).toBe(2);

    const cells = findAll(root, "c");
    expect(cells.length).toBe(3);
    expect(cells[0]?.attrs["t"]).toBe("s");

    const inlineText = findAll(root, "t");
    expect(inlineText[0]?.text).toBe("inline");
  });

  test("skips comments and doctype declarations", () => {
    const root = parseXml(
      "<!DOCTYPE foo><!-- a comment --><root><!-- inner --><child/></root>"
    );

    expect(root.name).toBe("root");
    expect(root.children.length).toBe(1);
  });

  test("throws on malformed input", () => {
    expect(() => parseXml("")).toThrow();
    expect(() => parseXml("just text")).toThrow();
    expect(() => parseXml("<unclosed")).toThrow();
  });
});

describe("getAttr", () => {
  test("matches attributes with or without namespace prefixes", () => {
    const root = parseXml('<sheet name="S" r:id="rId1"/>');

    expect(getAttr(root, "name")).toBe("S");
    expect(getAttr(root, "r:id")).toBe("rId1");
    expect(getAttr(root, "id")).toBe("rId1");
    expect(getAttr(root, "missing")).toBeUndefined();
  });
});
