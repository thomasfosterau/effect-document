/**
 * Tests for bridging between the tabular and document IR layers
 */

import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import {
  Paragraph,
  Table,
  cell,
  document,
  documentToWorkbook,
  plainText,
  sheet,
  str,
  workbookOf,
  workbookToDocument,
} from "../../src/core/index.js";

describe("workbookToDocument", () => {
  test("converts a single-sheet workbook into a document with one table", async () => {
    const wb = workbookOf(
      sheet(
        "People",
        [
          [cell.str("alice"), cell.num(30)],
          [cell.str("bob"), cell.num(25)],
        ],
        ["name", "age"]
      )
    );

    const doc = await Effect.runPromise(workbookToDocument(wb));

    expect(doc.blocks.length).toBe(1);
    const table = doc.blocks[0]!;
    expect(table._tag).toBe("Table");
    if (table._tag === "Table") {
      expect(table.caption).toBe("People");
      expect(table.head.length).toBe(1);
      expect(table.head[0]?.cells.length).toBe(2);
      expect(table.body.length).toBe(2);
    }
  });

  test("emits sheet headings for multi-sheet workbooks", async () => {
    const wb = workbookOf(sheet("First", []), sheet("Second", []));

    const doc = await Effect.runPromise(workbookToDocument(wb));

    expect(doc.blocks.map((b) => b._tag)).toEqual([
      "Heading",
      "Table",
      "Heading",
      "Table",
    ]);
  });

  test("renders typed cells as text in table cells", async () => {
    const wb = workbookOf(
      sheet("Mixed", [[cell.num(1.5), cell.bool(true), cell.empty()]])
    );

    const doc = await Effect.runPromise(workbookToDocument(wb));
    const table = doc.blocks[0]!;

    if (table._tag === "Table") {
      const row = table.body[0]!;
      expect(row.cells.length).toBe(3);
      // Null cells produce empty content
      expect(row.cells[2]?.content.length).toBe(0);
    }
  });
});

describe("documentToWorkbook", () => {
  test("extracts tables into sheets", async () => {
    const doc = document([
      new Table({
        caption: "Numbers",
        head: [],
        body: [],
      }),
    ]);

    const wb = await Effect.runPromise(documentToWorkbook(doc));

    expect(wb.sheets.length).toBe(1);
    expect(wb.sheets[0]?.name).toBe("Numbers");
  });

  test("ignores non-table blocks by default", async () => {
    const doc = document([
      new Paragraph({ content: [str("intro text")] }),
      new Table({ head: [], body: [] }),
    ]);

    const wb = await Effect.runPromise(documentToWorkbook(doc));
    expect(wb.sheets.length).toBe(1);
  });

  test("fails on non-table blocks when onNonTable is 'fail'", async () => {
    const doc = document([
      new Paragraph({ content: [str("intro text")] }),
      new Table({ head: [], body: [] }),
    ]);

    await expect(
      Effect.runPromise(documentToWorkbook(doc, { onNonTable: "fail" }))
    ).rejects.toThrow();
  });

  test("fails when the document has no tables", async () => {
    const doc = document([new Paragraph({ content: [str("just text")] })]);

    await expect(Effect.runPromise(documentToWorkbook(doc))).rejects.toThrow();
  });
});

describe("Round-trip Workbook -> Document -> Workbook", () => {
  test("preserves string cell values and headers", async () => {
    const original = workbookOf(
      sheet(
        "Data",
        [
          [cell.str("a"), cell.str("b")],
          [cell.str("c"), cell.str("d")],
        ],
        ["col1", "col2"]
      )
    );

    const roundTripped = await Effect.runPromise(
      workbookToDocument(original).pipe(
        Effect.flatMap((doc) => documentToWorkbook(doc))
      )
    );

    const s = roundTripped.sheets[0]!;
    expect(s.name).toBe("Data");
    expect(s.headers).toEqual(["col1", "col2"]);
    expect(s.rows).toEqual(original.sheets[0]!.rows);
  });
});
