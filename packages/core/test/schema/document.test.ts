import { it } from "@effect/vitest";
import { describe, expect, test } from "vite-plus/test";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  Document,
  Header,
  Para,
  Worksheet,
  blocksToText,
  cell,
  document,
  header,
  inlinesToText,
  para,
  plainText,
  str,
  strong,
  table,
  worksheet,
  rowsOf,
} from "../../src/schema/index.ts";

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
      ["name", "age", "active"],
    );
    expect(ws).toBeInstanceOf(Worksheet);
    // header row + 2 data rows
    expect(ws.rows).toHaveLength(3);
    expect(rowsOf(ws)[1]).toMatchObject({ index: 1 });
    expect(rowsOf(ws)[1]!.cells[1]).toMatchObject({ _tag: "CellNumber", value: 30 });
  });

  test("table takes more rows than a spread's argument limit (#225)", () => {
    const rows = Array.from({ length: 300_000 }, (_, k) => (k === 7 ? [[], [], []] : [[]]));
    const t = table({ rows });
    expect(t.body).toHaveLength(300_000);
    expect(t.colSpecs).toHaveLength(3);
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

  test("blocksToText includes table header rows, not just the body", () => {
    const t = table({ headers: ["A", "B"], rows: [[[plainText("1")], [plainText("2")]]] });
    expect(blocksToText([t])).toBe("A\tB\n1\t2");
  });
});

describe("JSON round-trip via Schema", () => {
  it.effect("encode then decode is identity (prose)", () =>
    Effect.gen(function* () {
      const doc = document([header(2, [str("Hi")]), para([str("body "), strong([str("bold")])])], {
        title: "t",
      });
      const encoded = yield* Schema.encodeEffect(Document)(doc);
      // encoded is plain JSON: it survives a JSON text round trip unchanged
      const Json = Schema.fromJsonString(Schema.Unknown);
      const json = yield* Schema.encodeEffect(Json)(encoded);
      expect(yield* Schema.decodeEffect(Json)(json)).toEqual(encoded);
      const decoded = yield* Schema.decodeEffect(Document)(encoded);
      expect(decoded).toEqual(doc);
    }),
  );

  it.effect("encode then decode is identity (spreadsheet with a date)", () =>
    Effect.gen(function* () {
      const doc = document([
        worksheet("S", [
          [
            cell.text("d"),
            cell.date(DateTime.toDateUtc(DateTime.makeUnsafe("2026-06-26T00:00:00.000Z"))),
          ],
        ]),
      ]);
      const encoded = yield* Schema.encodeEffect(Document)(doc);
      const decoded = yield* Schema.decodeEffect(Document)(encoded);
      expect(decoded).toEqual(doc);
    }),
  );
});
