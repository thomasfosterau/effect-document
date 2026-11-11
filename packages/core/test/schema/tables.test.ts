import { describe, expect, test } from "vite-plus/test";
import {
  bulletList,
  cell,
  Div,
  document,
  Figure,
  para,
  slide,
  slideShow,
  str,
  Table,
  TableCell,
  TableRow,
  TableShape,
  table,
  worksheet,
} from "../../src/schema/index.ts";
import { candidateTables } from "../../src/schema/tables.ts";

const cellOf = (t: string, span?: { rowSpan?: number; colSpan?: number }) =>
  new TableCell({ content: [para([str(t)])], ...span });

describe("candidateTables (#188)", () => {
  test("lists worksheets with their extent and a header guess", () => {
    const doc = document([
      worksheet("People", [
        [cell.text("name"), cell.text("age")],
        [cell.text("ada"), cell.number(36)],
      ]),
      worksheet("Notes", [[cell.text("a")], [cell.text("b")]]),
    ]);
    const [people, notes] = candidateTables(doc);
    expect(people).toMatchObject({
      _tag: "WorksheetRegion",
      locator: [0],
      name: "People",
      rows: 2,
      columns: 2,
      headerRow: true,
    });
    // all text: no evidence of a header
    expect(notes).toMatchObject({ locator: [1], name: "Notes", headerRow: false });
  });

  test("finds prose tables inside divs, figures, lists and other tables, in document order", () => {
    const inner = table({ rows: [[[para([str("deep")])]]] });
    const outer = new Table({
      colSpecs: [],
      head: [],
      body: [new TableRow({ cells: [new TableCell({ content: [inner] })] })],
      foot: [],
    });
    const doc = document([
      para([str("intro")]),
      new Div({ content: [table({ headers: ["h"], rows: [[[para([str("x")])]]] })] }),
      new Figure({ caption: [para([str("fig")])], content: [outer] }),
      bulletList([[para([str("item")]), table({ rows: [[[para([str("y")])]]] })]]),
    ]);
    expect(candidateTables(doc).map((r) => r.locator)).toEqual([
      [1, 0],
      [2, 0],
      [2, 0, "body", 0, 0, 0],
      [3, 0, 1],
    ]);
  });

  test("flattens a prose table to a grid, placing merged cells and reporting their spans", () => {
    const t = new Table({
      caption: [str("Totals")],
      colSpecs: [],
      head: [new TableRow({ cells: [cellOf("A", { colSpan: 2 }), cellOf("C")] })],
      body: [
        new TableRow({ cells: [cellOf("1", { rowSpan: 2 }), cellOf("2"), cellOf("3")] }),
        new TableRow({ cells: [cellOf("5"), cellOf("6")] }),
      ],
      foot: [],
    });
    const [region] = candidateTables(document([t]));
    expect(region).toMatchObject({
      _tag: "ProseTableRegion",
      caption: "Totals",
      rows: 3,
      columns: 3,
      headerRows: 1,
      cells: [
        ["A", "", "C"],
        ["1", "2", "3"],
        ["", "5", "6"],
      ],
      spans: [
        { row: 0, column: 0, rowSpan: 1, colSpan: 2 },
        { row: 1, column: 0, rowSpan: 2, colSpan: 1 },
      ],
    });
  });

  test("finds a slide's table shape, located by slide and shape", () => {
    const doc = document([
      slideShow([
        slide([]),
        slide([new TableShape({ table: table({ rows: [[[para([str("s")])]]] }) })]),
      ]),
    ]);
    expect(candidateTables(doc)).toEqual([
      expect.objectContaining({ _tag: "ProseTableRegion", locator: [0, 1, 0], rows: 1 }),
    ]);
  });

  test("a document without tables has none", () => {
    expect(candidateTables(document([para([str("just text")])]))).toEqual([]);
  });
});
