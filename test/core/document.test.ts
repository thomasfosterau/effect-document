/**
 * Tests for the document AST layer
 */

import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import {
  Code,
  Document,
  Emph,
  Heading,
  Paragraph,
  Space,
  Str,
  Strong,
  Table,
  TableCell,
  TableRow,
  blocksToText,
  document,
  inlinesToText,
  plainText,
  str,
} from "../../src/core/index.js";

describe("Document AST construction", () => {
  test("builds a document with mixed blocks", () => {
    const doc = document([
      new Heading({ level: 1, content: [str("Report")] }),
      new Paragraph({
        content: [str("Hello"), new Space(), new Strong({ content: [str("world")] })],
      }),
      new Table({
        caption: "Data",
        head: [new TableRow({ cells: [new TableCell({ content: [plainText("col")] })] })],
        body: [new TableRow({ cells: [new TableCell({ content: [plainText("val")] })] })],
      }),
    ]);

    expect(doc.blocks.length).toBe(3);
    expect(doc.blocks[0]?._tag).toBe("Heading");
    expect(doc.blocks[2]?._tag).toBe("Table");
  });

  test("rejects invalid heading levels", () => {
    expect(() => new Heading({ level: 7, content: [str("Too deep")] })).toThrow();
    expect(() => new Heading({ level: 0, content: [str("Too shallow")] })).toThrow();
  });
});

describe("Text collapsing", () => {
  test("inlinesToText flattens nested inline formatting", () => {
    const inlines = [
      str("Hello"),
      new Space(),
      new Emph({ content: [str("beautiful")] }),
      new Space(),
      new Strong({ content: [str("world"), new Space(), new Code({ text: "x = 1" })] }),
    ];

    expect(inlinesToText(inlines)).toBe("Hello beautiful world x = 1");
  });

  test("blocksToText joins blocks with newlines", () => {
    const blocks = [plainText("line one"), plainText("line two")];
    expect(blocksToText(blocks)).toBe("line one\nline two");
  });
});

describe("Schema serialization", () => {
  test("document round-trips through JSON encoding", () => {
    const original = document(
      [
        new Heading({ level: 2, content: [str("Section")] }),
        new Paragraph({
          content: [str("Some"), new Space(), new Emph({ content: [str("emphasis")] })],
        }),
        new Table({
          head: [],
          body: [
            new TableRow({
              cells: [
                new TableCell({ content: [plainText("a")] }),
                new TableCell({ content: [plainText("b")] }),
              ],
            }),
          ],
        }),
      ],
      { title: "Test Document" }
    );

    const encoded = Schema.encodeSync(Document)(original);
    const json = JSON.parse(JSON.stringify(encoded));
    const decoded = Schema.decodeUnknownSync(Document)(json);

    expect(decoded.meta).toEqual({ title: "Test Document" });
    expect(decoded.blocks.length).toBe(3);
    expect(decoded.blocks).toEqual(original.blocks);
  });
});
