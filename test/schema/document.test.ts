import { describe, expect, test } from "bun:test";
import { Effect, Schema } from "effect";
import {
  Document, Header, Para, Str, Strong, Worksheet, blocksToText, cell, document,
  header, inlinesToText, para, str, strong, worksheet,
} from "../../src/schema/index.js";

const run = <A, E>(e: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(e);

describe("schema constructors", () => {
  test("builds a prose document", () => {
    const doc = document([
      header(1, [str("Report")]),
      para([str("Sales were "), strong([str("up")])]),
    ]);
    expect(doc.blocks).toHaveLength(2);
    expect(doc.blocks[0]).toBeInstanceOf(Header);
    expect(doc.blocks[1]).toBeInstanceOf(Para);
  });

  test("builds a worksheet with typed cells", () => {
    const ws = worksheet(
      "People",
      [
        [cell.text("alice"), cell.number(30), cell.boolean(true)],
        [cell.text("bob"), cell.number(25), cell.blank()],
      ],
      ["name", "age", "active"]
    );
    expect(ws).toBeInstanceOf(Worksheet);
    // header row + 2 data rows
    expect(ws.rows).toHaveLength(3);
    expect(ws.rows[1]!.cells[1]).toMatchObject({ _tag: "CellNumber", value: 30 });
  });
});

describe("text collapse", () => {
  test("inlinesToText flattens formatting", () => {
    expect(inlinesToText([str("a "), strong([str("b")]), str(" c")])).toBe("a b c");
  });

  test("blocksToText renders worksheet rows tab-separated", () => {
    const ws = worksheet("S", [[cell.text("x"), cell.number(1)]]);
    expect(blocksToText([ws])).toBe("x\t1");
  });
});

describe("JSON round-trip via Schema", () => {
  test("encode then decode is identity (prose)", async () => {
    const doc = document(
      [header(2, [str("Hi")]), para([str("body "), strong([str("bold")])])],
      { title: "t" }
    );
    const encoded = await run(Schema.encode(Document)(doc));
    // encoded is plain JSON
    expect(JSON.parse(JSON.stringify(encoded))).toEqual(encoded as unknown as object);
    const decoded = await run(Schema.decode(Document)(encoded));
    expect(decoded).toEqual(doc);
  });

  test("encode then decode is identity (spreadsheet with a date)", async () => {
    const doc = document([
      worksheet("S", [[cell.text("d"), cell.date(new Date("2026-06-26T00:00:00.000Z"))]]),
    ]);
    const encoded = await run(Schema.encode(Document)(doc));
    const decoded = await run(Schema.decode(Document)(encoded));
    expect(decoded).toEqual(doc);
  });
});
