import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Predicate from "effect/Predicate";
import { assert, describe, expect, test } from "vite-plus/test";
import {
  cell,
  cellAt,
  CodeBlock,
  DefinitionItem,
  DefinitionList,
  Header,
  Link,
  Placeholder,
  document,
  header,
  para,
  str,
  strong,
  sheetRow,
  slide,
  slideShow,
  textBox,
  worksheet,
  blocksToText,
  SheetColumn,
  SheetRow,
  isPlainRow,
  Worksheet,
} from "../../src/schema/index.ts";
import {
  Profiles,
  collectFeatures,
  defineProfile,
  narrow,
  widen,
} from "../../src/profile/index.ts";

describe("widen", () => {
  test("is an identity at runtime", () => {
    // start from a branded Doc<CsvFeature> (a bare Document has no brand)
    const { document: doc } = narrow(document([worksheet("S", [[cell.text("a")]])]), Profiles.Csv);
    expect(widen(doc)).toBe(doc);
  });
});

describe("narrow: spreadsheet -> csv (the Excel -> CSV case)", () => {
  const excel = document([
    worksheet("Jan", [
      [
        cell.text("item"),
        cell.date(DateTime.toDateUtc(DateTime.makeUnsafe("2026-01-02T00:00:00.000Z"))),
      ],
      [cell.formula("=A1", "cached"), cell.number(3)],
    ]),
    worksheet("Feb", [[cell.number(9)]]),
  ]);

  test("drops extra sheets, converts dates & formulas, and reports the loss", () => {
    const { document: csv, loss } = narrow(excel, Profiles.Csv);

    // only the first worksheet survives
    const worksheets = csv.blocks.filter((b) => Predicate.isTagged(b, "Worksheet"));
    expect(worksheets).toHaveLength(1);

    // the date became text, the formula became its cached result
    const [firstRow, secondRow] = worksheets[0]!.rows;
    expect(cellAt(firstRow!, 1)?._tag).toBe("CellText");
    expect(cellAt(secondRow!, 0)).toMatchObject({ _tag: "CellText", value: "cached" });

    // the loss report names exactly what changed
    const features = loss.entries.map((e) => e.feature);
    expect(features).toEqual(
      expect.arrayContaining(["sheet.multiple", "cell.date", "cell.formula"]),
    );
    expect(loss.isLossless).toBe(false);

    // and the result actually conforms to the CSV profile
    expect(Profiles.Csv.is(csv)).toBe(true);
  });

  test("a document already in the target profile narrows losslessly", () => {
    const plain = document([worksheet("S", [[cell.text("a"), cell.number(1)]])]);
    const { loss, document: out } = narrow(plain, Profiles.Csv);
    expect(loss.isLossless).toBe(true);
    expect(Profiles.Csv.is(out)).toBe(true);
  });
});

describe("narrow: prose -> markdown subset", () => {
  test("unwraps unsupported inline formatting to text", () => {
    // Markdown allows strong but not, say, smallCaps; use an attr the profile lacks.
    const doc = document([para([str("hello "), strong([str("world")])])]);
    const { document: md } = narrow(doc, Profiles.Markdown);
    expect(Profiles.Markdown.is(md)).toBe(true);
    expect(blocksToText(md.blocks)).toBe("hello world");
  });

  test("a heading is preserved when the target supports it", () => {
    const doc = document([header(1, [str("Title")])]);
    const { loss, document: md } = narrow(doc, Profiles.Markdown);
    expect(loss.isLossless).toBe(true);
    expect(md.blocks[0]!._tag).toBe("Header");
  });
});

describe("narrow: attributes", () => {
  const attr = {
    id: "intro",
    classes: ["lead"],
    style: { font: { bold: true } },
    data: { source: "import" },
  };

  test("keeps the facets the target allows and reports each one it drops, in order", () => {
    const doc = document([new Header({ level: 1, attr, content: [str("Title")] })]);
    const { document: md, loss } = narrow(doc, Profiles.Markdown);
    const h = md.blocks[0];
    assert(Predicate.isTagged(h, "Header"));
    expect(h.attr).toEqual({ id: "intro", classes: ["lead"] });
    expect(loss.entries.map((e) => [e.feature, e.action])).toEqual([
      ["attr.style", "dropped"],
      ["attr.keyValue", "dropped"],
    ]);
  });

  test("an attribute set with nothing left is removed entirely", () => {
    const doc = document([
      new Header({ level: 1, attr: { style: attr.style, classes: [] }, content: [str("T")] }),
    ]);
    const { document: md } = narrow(doc, Profiles.Markdown);
    const h = md.blocks[0];
    assert(Predicate.isTagged(h, "Header"));
    expect(h.attr).toBeUndefined();
  });
});

describe("narrow: column-level styling", () => {
  // a profile allowing column metadata but not styling
  const Columns = defineProfile("columns", [
    "sheet.worksheet",
    "sheet.columns",
    "cell.text",
    "cell.number",
  ] as const);

  test("strips per-column styles the target can't represent (and reports it)", () => {
    const doc = document([
      new Worksheet({
        name: "S",
        columns: [new SheetColumn({ width: 10, style: { font: { bold: true } } })],
        rows: [sheetRow(0, [cell.text("a")])],
        merges: [],
      }),
    ]);
    const { document: out, loss } = narrow(doc, Columns);
    expect(Columns.is(out)).toBe(true); // must actually conform
    expect(loss.entries.some((e) => e.feature === "cell.style")).toBe(true);
  });
});

describe("narrow: hidden rows, columns and worksheets (#66)", () => {
  // column and row metadata, but nothing hidden
  const Shown = defineProfile("shown", [
    "sheet.worksheet",
    "sheet.multiple",
    "sheet.columns",
    "cell.text",
  ] as const);

  test("shows what the target can't hide, one loss entry for each kind", () => {
    const hidden = new Worksheet({
      name: "H",
      columns: [new SheetColumn({ width: 10, hidden: true }), new SheetColumn({ hidden: true })],
      rows: [new SheetRow({ index: 0, cells: [cell.text("a")], hidden: true, height: 30 })],
      merges: [],
      visibility: "veryHidden",
    });
    const { document: out, loss } = narrow(document([worksheet("S", [["x"]]), hidden]), Shown);
    expect(Shown.is(out)).toBe(true);
    const ws = out.blocks[1];
    assert(Predicate.isTagged(ws, "Worksheet"));
    expect(ws.visibility).toBeUndefined();
    expect(ws.columns.map((c) => [c.width, c.hidden])).toEqual([
      [10, undefined],
      [undefined, undefined],
    ]);
    const [row] = ws.rows;
    assert(row !== undefined && !isPlainRow(row));
    expect([row.hidden, row.height]).toEqual([undefined, 30]);
    expect(loss.entries.filter((e) => e.feature === "sheet.hidden").map((e) => e.detail)).toEqual([
      'hidden worksheet "H" shown',
      "hidden columns shown",
      "hidden rows shown",
    ]);
  });

  test("a profile with sheet.hidden keeps all three, losslessly", () => {
    const Hides = defineProfile("hides", [
      "sheet.worksheet",
      "sheet.columns",
      "sheet.hidden",
      "cell.text",
    ] as const);
    const ws = new Worksheet({
      name: "H",
      columns: [new SheetColumn({ hidden: true })],
      rows: [new SheetRow({ index: 0, cells: [cell.text("a")], hidden: true })],
      merges: [],
      visibility: "hidden",
    });
    const doc = document([ws]);
    expect(Hides.is(doc)).toBe(true);
    const { document: out, loss } = narrow(doc, Hides);
    expect(out.blocks[0]).toBe(ws);
    expect(loss.isLossless).toBe(true);
  });
});

describe("narrow: spreadsheet -> prose", () => {
  test("converts a worksheet to a prose table", () => {
    const doc = document([worksheet("S", [[cell.text("a"), cell.number(1)]])]);
    const { document: prose, loss } = narrow(doc, Profiles.Markdown);
    expect(prose.blocks[0]!._tag).toBe("Table");
    expect(loss.entries.some((e) => e.feature === "sheet.worksheet")).toBe(true);
  });
});

describe("narrow: structural rules (notWithin, #197)", () => {
  const BoldHeadings = defineProfile(
    "bold-headings",
    ["block.para", "block.header", "inline.str", "inline.space", "inline.strong"],
    {
      notWithin: [
        { feature: "inline.strong", within: "block.header", reason: "headings are bold" },
      ],
    },
  );

  test("unwraps a feature inside the node a rule keeps it out of, giving the rule's reason", () => {
    const doc = document([header(1, [str("a "), strong([str("b")])])]);
    const { document: out, loss } = narrow(doc, BoldHeadings);
    expect(out.blocks).toEqual([header(1, [str("a "), str("b")])]);
    expect(loss.isLossless).toBe(false);
    expect(loss.entries).toEqual([
      {
        feature: "inline.strong",
        action: "converted",
        detail: "Strong unwrapped to its text: headings are bold",
        severity: "converted",
        path: [0, 1],
      },
    ]);
    expect(BoldHeadings.is(out)).toBe(true);
  });

  test("keeps the feature outside that node", () => {
    const doc = document([para([str("a "), strong([str("b")])])]);
    const { loss } = narrow(doc, BoldHeadings);
    expect(loss.isLossless).toBe(true);
  });

  test("a heading narrowed to a paragraph keeps its Strong", () => {
    const NoHeadings = defineProfile(
      "no-headings",
      ["block.para", "inline.str", "inline.space", "inline.strong"],
      {
        notWithin: [{ feature: "inline.strong", within: "block.header", reason: "unused" }],
      },
    );
    const { document: out } = narrow(document([header(1, [strong([str("b")])])]), NoHeadings);
    expect(out.blocks).toEqual([para([strong([str("b")])])]);
  });
});

/** A deck of one slide holding a placeholder for each of `shapes`. */
const deck = (...shapes: ConstructorParameters<typeof Placeholder>[0][]) =>
  document([slideShow([slide(shapes.map((s) => new Placeholder(s)))])]);
/** A title placeholder's fields, holding `content`. */
const title = (content: ConstructorParameters<typeof Placeholder>[0]["content"]) => ({
  placeholderType: "title",
  content,
});

describe("narrow: structural rules (onlyWithin, fieldValues, #126)", () => {
  const Titles = defineProfile(
    "titles",
    [
      "deck.slideShow",
      "shape.textBox",
      "shape.placeholder",
      "block.para",
      "block.header",
      "inline.str",
    ],
    {
      onlyWithin: [
        {
          feature: "block.header",
          within: "shape.placeholder",
          where: { field: "placeholderType", oneOf: ["title"] },
          reason: "headings are slide titles",
        },
      ],
      fieldValues: [
        { feature: "block.header", field: "level", oneOf: [1], reason: "titles have one level" },
      ],
    },
  );

  test("a level-1 heading in a title placeholder conforms and narrows losslessly", () => {
    const doc = deck(title([header(1, [str("T")])]));
    expect(Titles.is(doc)).toBe(true);
    expect(narrow(doc, Titles).loss.isLossless).toBe(true);
  });

  test("a heading outside the node an onlyWithin rule names breaks it and narrows to a paragraph", () => {
    const doc = deck({ placeholderType: "body", content: [header(1, [str("T")])] });
    expect(Titles.is(doc)).toBe(false);
    const { document: out, loss } = narrow(doc, Titles);
    expect(out).toEqual(deck({ placeholderType: "body", content: [para([str("T")])] }));
    expect(loss.entries).toEqual([
      {
        feature: "block.header",
        action: "converted",
        detail: "heading converted to a paragraph: headings are slide titles",
        severity: "converted",
        path: [0, 0, 0, 0],
      },
    ]);
    expect(Titles.is(out)).toBe(true);
  });

  test("a heading in a text box or at the top level breaks the onlyWithin rule", () => {
    expect(Titles.is(document([slideShow([slide([textBox([header(1, [str("T")])])])])]))).toBe(
      false,
    );
    expect(Titles.is(document([header(1, [str("T")])]))).toBe(false);
  });

  test("a heading at another level breaks the fieldValues rule and narrows to a paragraph", () => {
    const doc = deck(title([header(2, [str("T")])]));
    expect(Titles.is(doc)).toBe(false);
    const { document: out, loss } = narrow(doc, Titles);
    expect(out).toEqual(deck(title([para([str("T")])])));
    expect(loss.entries).toEqual([
      {
        feature: "block.header",
        action: "converted",
        detail: "heading converted to a paragraph: titles have one level",
        severity: "converted",
        path: [0, 0, 0, 0],
      },
    ]);
  });

  it.effect("without rules a profile has none, and validate names the broken rule's feature", () =>
    Effect.gen(function* () {
      const Plain = defineProfile("plain", ["block.para"]);
      expect(Plain.onlyWithin).toEqual([]);
      expect(Plain.fieldValues).toEqual([]);
      const error = yield* Effect.flip(Titles.validate(deck(title([header(3, [str("T")])]))));
      expect(error.unsupported).toEqual(["block.header"]);
    }),
  );
});

describe("per-node id facets (#184)", () => {
  const HeadingIds = defineProfile("heading-ids", [
    "block.para",
    "block.header",
    "inline.str",
    "inline.link",
    "attr.id.header",
  ]);
  const doc = document([
    new Header({ level: 1, attr: { id: "top" }, content: [str("T")] }),
    para([new Link({ attr: { id: "l" }, content: [str("x")], target: { url: "#top" } })]),
  ]);

  test("a document's ids are collected per node", () => {
    const used = collectFeatures(doc);
    expect(used.has("attr.id.header")).toBe(true);
    expect(used.has("attr.id.link")).toBe(true);
    expect(used.has("attr.id")).toBe(false);
  });

  test("narrow keeps an id only on the nodes the profile allows it on", () => {
    const { document: out, loss } = narrow(doc, HeadingIds);
    expect(HeadingIds.is(out)).toBe(true);
    const [h, p] = out.blocks;
    assert(Predicate.isTagged(h, "Header") && Predicate.isTagged(p, "Para"));
    expect(h.attr?.id).toBe("top");
    const link = p.content[0];
    assert(Predicate.isTagged(link, "Link"));
    expect(link.attr).toBe(undefined);
    expect(loss.entries).toEqual([
      {
        feature: "attr.id.link",
        action: "dropped",
        detail: "format does not support ids on Link nodes",
        severity: "dropped-formatting",
        path: [1, 0],
      },
    ]);
  });

  test("attr.id stands for every per-node facet", () => {
    const Ids = defineProfile("ids", [
      "block.para",
      "block.header",
      "inline.str",
      "inline.link",
      "attr.id",
    ]);
    expect(Ids.features.has("attr.id.link")).toBe(true);
    expect(Ids.is(doc)).toBe(true);
    expect(narrow(doc, Ids).loss.isLossless).toBe(true);
    expect(HeadingIds.is(doc)).toBe(false);
  });

  test("ids on code blocks and definition lists, and their contents, are narrowed too", () => {
    const rich = document([
      new CodeBlock({ attr: { id: "c" }, text: "x" }),
      new DefinitionList({
        attr: { id: "d" },
        items: [
          new DefinitionItem({ term: [strong([str("t")])], definitions: [[para([str("d")])]] }),
        ],
      }),
    ]);
    const { document: out } = narrow(rich, Profiles.Csv);
    expect(Profiles.Csv.is(out)).toBe(true);
  });
});
