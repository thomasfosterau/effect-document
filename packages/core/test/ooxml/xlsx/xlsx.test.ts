import { it } from "@effect/vitest";
import * as Predicate from "effect/Predicate";
import { assert, describe, expect, test } from "vite-plus/test";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import {
  type Block,
  bytes,
  cell,
  cellToText,
  denseRows,
  type SheetCell,
  rowEntries,
  rowsOf,
  sheetExtent,
  type Doc,
  document,
  trustAs,
  worksheet,
  Worksheet,
} from "@thomasfosterau/effect-document";
import {
  makeXlsxReader,
  makeXlsxWriter,
  sanitizeSheetNames,
  type XlsxFeature,
  type XlsxReadFeature,
} from "../../../src/ooxml/xlsx/index.ts";
import { Spreadsheet } from "@thomasfosterau/effect-document/profiles";

type SpreadsheetF = XlsxFeature;

const worksheets = (doc: { blocks: ReadonlyArray<Block> }): Worksheet[] =>
  doc.blocks.filter((b) => Predicate.isTagged(b, "Worksheet"));

/** A worksheet's dense grid, for positional assertions. */
const grid = (ws: Worksheet) => {
  const rows = denseRows(ws);
  assert(Result.isSuccess(rows), "the grid fits the default budget");
  return rows.success;
};

const NS_MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const NS_PKG = "http://schemas.openxmlformats.org/package/2006/relationships";
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

const sheetXml = (body: string, head = "") =>
  `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="${NS_MAIN}">${head}` +
  `<sheetData>${body}</sheetData></worksheet>`;

/**
 * Build a package from worksheet XML. A string is a single sheet "S"; extra
 * sheets may name another relationship type (e.g. "chartsheet").
 */
const packageWith = (
  sheets: string | ReadonlyArray<{ name: string; xml: string; type?: string }>,
  sharedStrings?: string,
) => {
  const list = Predicate.isString(sheets) ? [{ name: "S", xml: sheets }] : sheets;
  const files = {
    "_rels/.rels": strToU8(
      `<Relationships xmlns="${NS_PKG}"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    ),
    "xl/workbook.xml": strToU8(
      `<workbook xmlns="${NS_MAIN}" xmlns:r="${REL}"><sheets>` +
        list
          .map((s, i) => `<sheet name="${s.name}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
          .join("") +
        `</sheets></workbook>`,
    ),
    "xl/_rels/workbook.xml.rels": strToU8(
      `<Relationships xmlns="${NS_PKG}">` +
        list
          .map(
            (s, i) =>
              `<Relationship Id="rId${i + 1}" Type="${s.type?.includes("://") ? s.type : `${REL}/${s.type ?? "worksheet"}`}" Target="worksheets/sheet${i + 1}.xml"/>`,
          )
          .join("") +
        (sharedStrings === undefined
          ? ""
          : `<Relationship Id="rIdS" Type="${REL}/sharedStrings" Target="sharedStrings.xml"/>`) +
        `</Relationships>`,
    ),
    ...Object.fromEntries(list.map((s, i) => [`xl/worksheets/sheet${i + 1}.xml`, strToU8(s.xml)])),
  };
  return bytes(
    zipSync(
      sharedStrings === undefined
        ? files
        : {
            ...files,
            "xl/sharedStrings.xml": strToU8(`<sst xmlns="${NS_MAIN}">${sharedStrings}</sst>`),
          },
    ),
  );
};

describe("XLSX round-trip", () => {
  it.effect("preserves typed cells across write -> read", () =>
    Effect.gen(function* () {
      const doc = trustAs<SpreadsheetF>(
        document([
          worksheet("People", [
            [cell.text("alice"), cell.number(30), cell.boolean(true)],
            [cell.text("bob"), cell.number(25), cell.blank()],
          ]),
        ]),
      );
      const xlsx = yield* makeXlsxWriter().write(doc);
      expect(xlsx._tag).toBe("Bytes");

      const back = yield* makeXlsxReader().read(xlsx);
      const ws = worksheets(back)[0]!;
      expect(ws.name).toBe("People");
      expect(grid(ws)[0]![0]).toMatchObject({ _tag: "CellText", value: "alice" });
      expect(grid(ws)[0]![1]).toMatchObject({ _tag: "CellNumber", value: 30 });
      expect(grid(ws)[0]![2]).toMatchObject({ _tag: "CellBoolean", value: true });
    }),
  );

  it.effect("preserves multiple sheets", () =>
    Effect.gen(function* () {
      const doc = trustAs<SpreadsheetF>(
        document([worksheet("A", [[cell.number(1)]]), worksheet("B", [[cell.number(2)]])]),
      );
      const xlsx = yield* makeXlsxWriter().write(doc);
      const back = yield* makeXlsxReader().read(xlsx);
      expect(worksheets(back).map((w) => w.name)).toEqual(["A", "B"]);
    }),
  );

  it.effect("reader output conforms to the Spreadsheet profile", () =>
    Effect.gen(function* () {
      const doc = trustAs<SpreadsheetF>(document([worksheet("S", [[cell.error("#DIV/0!")]])]));
      const xlsx = yield* makeXlsxWriter().write(doc);
      const back: Doc<XlsxReadFeature> = yield* makeXlsxReader().read(xlsx);
      expect(Spreadsheet.is(back)).toBe(true);
      expect(grid(worksheets(back)[0]!)[0]![0]).toMatchObject({ _tag: "CellError" });
    }),
  );

  it.effect("round-trips a formula cell as CellFormula (not flattened text)", () =>
    Effect.gen(function* () {
      const doc = trustAs<SpreadsheetF>(document([worksheet("S", [[cell.formula("A1+1", "42")]])]));
      const xlsx = yield* makeXlsxWriter().write(doc);
      const back = yield* makeXlsxReader().read(xlsx);
      expect(grid(worksheets(back)[0]!)[0]![0]).toMatchObject({
        _tag: "CellFormula",
        formula: "A1+1",
        result: "42",
      });
    }),
  );

  it.effect("blank cells are neither written nor read back: the sheet is sparse", () =>
    Effect.gen(function* () {
      const doc = trustAs<SpreadsheetF>(
        document([
          worksheet("S", [
            [cell.text("a"), cell.text("b"), cell.blank()],
            [cell.blank(), cell.blank(), cell.blank()],
            [cell.blank(), cell.text("d")],
          ]),
        ]),
      );
      const xlsx = yield* makeXlsxWriter().write(doc);
      assert(Predicate.isTagged(xlsx, "Bytes"));
      const sheet = strFromU8(unzipSync(xlsx.bytes)["xl/worksheets/sheet1.xml"]!);
      expect(sheet).toContain(`<dimension ref="A1:C3"/>`);
      expect(sheet.match(/<c /g)).toHaveLength(3);
      const ws = worksheets(yield* makeXlsxReader().read(xlsx))[0]!;
      expect(columnsOf(ws)).toEqual([
        [0, [0, 1]],
        [2, [1]],
      ]);
    }),
  );
});

/** A worksheet's extent, as `[rows, columns]`. */
const extent = (ws: Worksheet) => {
  const { rows, columns } = sheetExtent(ws);
  return [rows, columns];
};
/** How many cells a worksheet holds. */
const held = (ws: Worksheet) => ws.rows.reduce((n, r) => n + rowEntries(r).length, 0);

/** Each row's index and the columns of the cells it holds. */
const columnsOf = (ws: Worksheet) =>
  rowsOf(ws).map((r) => [r.index, rowEntries(r).map(([col]) => col)]);

describe("XLSX reader sparse worksheets (#62, #185)", () => {
  it.effect("empty rows and style-only cells are not kept", () =>
    Effect.gen(function* () {
      const xlsx = packageWith(
        sheetXml(
          `<row r="1"><c r="A1"><v>1</v></c><c r="Z1" s="3"/></row>` +
            `<row r="50000"/>` +
            `<row r="1048576"><c r="XFD1048576" s="2"/></row>`,
        ),
      );
      const ws = worksheets(yield* makeXlsxReader().read(xlsx))[0]!;
      expect(extent(ws)).toEqual([1, 1]);
      expect(held(ws)).toBe(1);
    }),
  );

  it.effect("a value at A1 and one far out hold two rows; the far one costs its width", () =>
    Effect.gen(function* () {
      const xlsx = packageWith(
        sheetXml(
          `<row r="1"><c r="A1"><v>1</v></c></row>` +
            `<row r="1048576"><c r="XFD1048576"><v>2</v></c></row>`,
        ),
      );
      // the million rows between cost nothing; the far row is 16,384 positions
      const error = yield* Effect.flip(makeXlsxReader({ maxCells: 16_384 }).read(xlsx));
      expect(error.reason).toContain("maxCells");
      const ws = worksheets(yield* makeXlsxReader({ maxCells: 16_385 }).read(xlsx))[0]!;
      expect(held(ws)).toBe(2);
      expect(extent(ws)).toEqual([1_048_576, 16_384]);
      expect(columnsOf(ws)).toEqual([
        [0, [0]],
        [1_048_575, [16_383]],
      ]);
    }),
  );

  it.effect("rows and cells out of document order read back ascending", () =>
    Effect.gen(function* () {
      const xlsx = packageWith(
        sheetXml(
          `<row r="3"><c r="C3"><v>3</v></c><c r="A3"><v>1</v></c></row>` +
            `<row r="1"><c r="B1"><v>2</v></c></row>`,
        ),
      );
      const ws = worksheets(yield* makeXlsxReader().read(xlsx))[0]!;
      expect(columnsOf(ws)).toEqual([
        [0, [1]],
        [2, [0, 2]],
      ]);
    }),
  );

  it.effect("maxCells counts each row's width (to its last valued cell) and is configurable", () =>
    Effect.gen(function* () {
      const xlsx = packageWith(
        sheetXml(
          `<row r="10"><c r="A10"><v>1</v></c><c r="J10"><v>2</v></c><c r="Z10" s="1"/></row>`,
        ),
      );
      // A10 and J10 valued (Z10 is style-only): a row ten positions wide
      const error = yield* Effect.flip(makeXlsxReader({ maxCells: 9 }).read(xlsx));
      expect(error._tag).toBe("ParseError");
      expect(error.reason).toContain("maxCells");
      const ws = worksheets(yield* makeXlsxReader({ maxCells: 10 }).read(xlsx))[0]!;
      expect(held(ws)).toBe(2);
    }),
  );

  it.effect("<dimension> is only a hint and is not read", () =>
    Effect.gen(function* () {
      const body = `<row r="1"><c r="A1"><v>1</v></c></row>`;
      yield* Effect.forEach(
        ["A1:C2", "A1:XFD1048576"],
        (ref) =>
          Effect.map(
            makeXlsxReader({ maxCells: 1 }).read(
              packageWith(sheetXml(body, `<dimension ref="${ref}"/>`)),
            ),
            (doc) => expect(extent(worksheets(doc)[0]!)).toEqual([1, 1]),
          ),
        { concurrency: 1, discard: true },
      );
    }),
  );

  it.effect("maxCells bounds the whole workbook, not each sheet", () =>
    Effect.gen(function* () {
      // Each sheet's row is five positions wide, under the limit on its own; together they are not.
      const sheet = sheetXml(`<row r="10"><c r="A10"><v>1</v></c><c r="E10"><v>2</v></c></row>`);
      const xlsx = packageWith([
        { name: "A", xml: sheet },
        { name: "B", xml: sheet },
        { name: "C", xml: sheet },
      ]);
      const error = yield* Effect.flip(makeXlsxReader({ maxCells: 14 }).read(xlsx));
      expect(error._tag).toBe("ParseError");
      expect(error.reason).toContain('"C"');
      expect(error.reason).toContain("maxCells");
      const read = worksheets(yield* makeXlsxReader({ maxCells: 15 }).read(xlsx));
      expect(read.map(extent)).toEqual([
        [10, 5],
        [10, 5],
        [10, 5],
      ]);
    }),
  );
});

/** The worksheets read from a package. */
const readSheets = (xlsx: ReturnType<typeof packageWith>) =>
  Effect.gen(function* () {
    return worksheets(yield* makeXlsxReader().read(xlsx));
  });
/** A worksheet's dense grid, as text. */
const cellTexts = (ws: Worksheet) => grid(ws).map((r) => r.map((c) => cellToText(c)));

describe("XLSX reader fixes (#60)", () => {
  it.effect("chartsheets, dialogsheets and macrosheets read as empty tagged sheets", () =>
    Effect.gen(function* () {
      const xlsx = packageWith([
        { name: "Data", xml: sheetXml(`<row r="1"><c r="A1"><v>1</v></c></row>`) },
        { name: "Chart", xml: `<chartsheet xmlns="${NS_MAIN}"/>`, type: "chartsheet" },
        { name: "Dialog", xml: `<dialogsheet xmlns="${NS_MAIN}"/>`, type: "dialogsheet" },
        {
          name: "Macro",
          xml: `<worksheet xmlns="${NS_MAIN}"/>`,
          type: "http://schemas.microsoft.com/office/2006/relationships/xlMacrosheet",
        },
      ]);
      const sheets = yield* readSheets(xlsx);
      expect(sheets.map((s) => s.name)).toEqual(["Data", "Chart", "Dialog", "Macro"]);
      expect(sheets.map((s) => s.attr?.data?.["kind"])).toEqual([
        undefined,
        "chartsheet",
        "dialogsheet",
        "macrosheet",
      ]);
      expect(sheets[1]!.rows).toEqual([]);
    }),
  );

  it.effect(
    "a sheet the workbook lists without a part reads as an empty unlinked sheet (POI 60825)",
    () =>
      Effect.gen(function* () {
        const xlsx = bytes(
          zipSync({
            "_rels/.rels": strToU8(
              `<Relationships xmlns="${NS_PKG}"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
            ),
            "xl/workbook.xml": strToU8(
              `<workbook xmlns="${NS_MAIN}" xmlns:r="${REL}"><sheets>` +
                `<sheet name="Data" sheetId="1" r:id="rId1"/><sheet name="Module" sheetId="2" r:id=""/>` +
                `</sheets></workbook>`,
            ),
            "xl/_rels/workbook.xml.rels": strToU8(
              `<Relationships xmlns="${NS_PKG}"><Relationship Id="rId1" Type="${REL}/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
            ),
            "xl/worksheets/sheet1.xml": strToU8(
              sheetXml(`<row r="1"><c r="A1"><v>1</v></c></row>`),
            ),
          }),
        );
        const sheets = yield* readSheets(xlsx);
        expect(sheets.map((s) => [s.name, s.attr?.data?.["kind"], s.rows.length])).toEqual([
          ["Data", undefined, 1],
          ["Module", "unlinked", 0],
        ]);
      }),
  );

  it.effect("a sheet whose relationship doesn't resolve still fails the read", () =>
    Effect.gen(function* () {
      const xlsx = packageWith([{ name: "S", xml: sheetXml(""), type: "nonsense" }]);
      const failed = yield* Effect.flip(makeXlsxReader().read(xlsx));
      expect(failed.reason).toMatch(/Cannot resolve worksheet part/);
    }),
  );

  it.effect("cells and rows without r follow the previous one", () =>
    Effect.gen(function* () {
      const xlsx = packageWith(
        sheetXml(
          `<row r="1"><c r="C1"><v>1</v></c><c><v>2</v></c></row>` +
            `<row><c><v>3</v></c><c><v>4</v></c></row>`,
        ),
      );
      expect(cellTexts((yield* readSheets(xlsx))[0]!)).toEqual([
        ["", "", "1", "2"],
        ["3", "4", "", ""],
      ]);
    }),
  );

  it.effect("shared formulas are translated to each dependent cell", () =>
    Effect.gen(function* () {
      const xlsx = packageWith(
        sheetXml(
          `<row r="1"><c r="C1"><f t="shared" ref="C1:D2" si="0">A1+$B1+B$1+SUM(A:A)+LOG10(A1)+"A1"</f><v>1</v></c>` +
            `<c r="D1"><f t="shared" si="0"/><v>2</v></c></row>` +
            `<row r="2"><c r="C2"><f t="shared" si="0"/><v>3</v></c></row>`,
        ),
      );
      const cells = grid((yield* readSheets(xlsx))[0]!);
      expect(cells[0]![2]).toMatchObject({ formula: `A1+$B1+B$1+SUM(A:A)+LOG10(A1)+"A1"` });
      expect(cells[0]![3]).toMatchObject({
        formula: `B1+$B1+C$1+SUM(B:B)+LOG10(B1)+"A1"`,
        result: "2",
      });
      expect(cells[1]![2]).toMatchObject({ formula: `A2+$B2+B$1+SUM(A:A)+LOG10(A2)+"A1"` });
    }),
  );

  it.effect("phonetic guide text is not part of the string", () =>
    Effect.gen(function* () {
      const xlsx = packageWith(
        sheetXml(`<row r="1"><c r="A1" t="s"><v>0</v></c></row>`),
        `<si><t>東京</t><rPh sb="0" eb="2"><t>トウキョウ</t></rPh></si>`,
      );
      expect(cellTexts((yield* readSheets(xlsx))[0]!)).toEqual([["東京"]]);
    }),
  );

  it.effect("_xHHHH_ escapes are decoded", () =>
    Effect.gen(function* () {
      const xlsx = packageWith(
        sheetXml(
          `<row r="1"><c r="A1" t="s"><v>0</v></c>` +
            `<c r="B1" t="inlineStr"><is><t>tab_x0009_here _x005F_x0041_</t></is></c></row>`,
        ),
        `<si><t>line_x000D_break</t></si>`,
      );
      expect(cellTexts((yield* readSheets(xlsx))[0]!)).toEqual([
        ["line\rbreak", "tab\there _x0041_"],
      ]);
    }),
  );

  it.effect('t="d" cells read as dates', () =>
    Effect.gen(function* () {
      const xlsx = packageWith(
        sheetXml(`<row r="1"><c r="A1" t="d"><v>2024-03-05T00:00:00Z</v></c></row>`),
      );
      const c = grid((yield* readSheets(xlsx))[0]!)[0]![0]!;
      expect(c._tag).toBe("CellDate");
      expect(Predicate.isTagged(c, "CellDate") && c.value.toISOString()).toBe(
        "2024-03-05T00:00:00.000Z",
      );
    }),
  );
});

/** A spreadsheet document of named sheets. */
const sheetDoc = (...sheets: Array<[string, SheetCell[][]]>) =>
  trustAs<SpreadsheetF>(document(sheets.map(([name, rows]) => worksheet(name, rows))));
/** Write `doc`, and return a lookup of its package parts' text by path. */
const parts = (doc: Doc<SpreadsheetF>) =>
  Effect.gen(function* () {
    const out = yield* makeXlsxWriter().write(doc);
    assert(Predicate.isTagged(out, "Bytes"), "expected bytes");
    const files = unzipSync(out.bytes);
    return (path: string) => (files[path] === undefined ? undefined : strFromU8(files[path]));
  });

describe("XLSX writer validity (#61)", () => {
  it.effect("NaN and ±Infinity are written as #NUM! errors", () =>
    Effect.gen(function* () {
      const doc = sheetDoc([
        "S",
        [[cell.number(Number.NaN), cell.number(Infinity), cell.number(1)]],
      ]);
      const part = yield* parts(doc);
      expect(part("xl/worksheets/sheet1.xml")).not.toContain("NaN");
      const back = worksheets(yield* makeXlsxReader().read(yield* makeXlsxWriter().write(doc)));
      expect(grid(back[0]!)[0]!.map((c) => c._tag)).toEqual([
        "CellError",
        "CellError",
        "CellNumber",
      ]);
      expect(grid(back[0]!)[0]![0]).toMatchObject({ value: "#NUM!" });
    }),
  );

  it.effect("characters invalid in XML are _xHHHH_-encoded and round-trip", () =>
    Effect.gen(function* () {
      const tricky = "a\u0001b\u001Fc\td\ne_x0041_f\uD800g";
      const doc = sheetDoc(["S", [[cell.text(tricky), cell.formula(`"\u0002"`, "\u0003")]]]);
      const part = yield* parts(doc);
      const sst = part("xl/sharedStrings.xml")!;
      expect(sst).toContain("a_x0001_b_x001F_c\td\ne_x005F_x0041_f_xD800_g");
      // oxlint-disable-next-line eslint/no-control-regex -- asserts no C0 control survives the encoding
      expect(/[\u0000-\u0008]/.test(sst + part("xl/worksheets/sheet1.xml"))).toBe(false);
      const back = worksheets(yield* makeXlsxReader().read(yield* makeXlsxWriter().write(doc)));
      expect(grid(back[0]!)[0]![0]).toMatchObject({ value: tricky });
      expect(grid(back[0]!)[0]![1]).toMatchObject({ formula: `"\u0002"`, result: "\u0003" });
    }),
  );

  test("sheet names are sanitised deterministically", () => {
    expect(
      sanitizeSheetNames([
        "a[b]:c*?/\\d",
        "",
        "History",
        "data",
        "DATA",
        "x".repeat(40),
        "x".repeat(40),
        "'q'",
      ]),
    ).toEqual([
      "a_b__c____d",
      "Sheet2",
      "History_",
      "data",
      "DATA (2)",
      "x".repeat(31),
      `${"x".repeat(27)} (2)`,
      "q",
    ]);
  });

  it.effect("written sheet names are the sanitised ones", () =>
    Effect.gen(function* () {
      const back = worksheets(
        yield* makeXlsxReader().read(
          yield* makeXlsxWriter().write(
            sheetDoc(["A/B", [[cell.number(1)]]], ["a/b", [[cell.number(2)]]]),
          ),
        ),
      );
      expect(back.map((w) => w.name)).toEqual(["A_B", "a_b (2)"]);
    }),
  );

  it.effect("a leading = is stripped from formulas", () =>
    Effect.gen(function* () {
      const part = yield* parts(sheetDoc(["S", [[cell.formula("=A1+1", "2")]]]));
      expect(part("xl/worksheets/sheet1.xml")).toContain("<f>A1+1</f>");
    }),
  );

  it.effect("fullCalcOnLoad is set only when a formula lacks a cached result", () =>
    Effect.gen(function* () {
      expect(
        (yield* parts(sheetDoc(["S", [[cell.formula("1+1", "2")]]])))("xl/workbook.xml"),
      ).not.toContain("calcPr");
      expect((yield* parts(sheetDoc(["S", [[cell.formula("1+1")]]])))("xl/workbook.xml")).toContain(
        `<calcPr fullCalcOnLoad="1"/>`,
      );
    }),
  );

  it.effect("sst count is the reference count and uniqueCount the distinct count", () =>
    Effect.gen(function* () {
      const part = yield* parts(
        sheetDoc(["S", [[cell.text("a"), cell.text("a"), cell.text("b")]]]),
      );
      expect(part("xl/sharedStrings.xml")).toContain(`count="3" uniqueCount="2"`);
    }),
  );

  it.effect("docProps core.xml and app.xml are written and related", () =>
    Effect.gen(function* () {
      const part = yield* parts(sheetDoc(["S", [[cell.number(1)]]]));
      expect(part("docProps/core.xml")).toContain("coreProperties");
      expect(part("docProps/app.xml")).toContain("<Application>");
      expect(part("_rels/.rels")).toContain(`Target="docProps/core.xml"`);
      expect(part("[Content_Types].xml")).toContain(`PartName="/docProps/app.xml"`);
    }),
  );

  it.effect("random grids with edge-case values round-trip", () =>
    Effect.gen(function* () {
      // A small seeded generator (no property-testing dependency).
      let seed = 42;
      const rand = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
      const pick = <A>(xs: ReadonlyArray<A>): A => xs[Math.floor(rand() * xs.length)]!;
      const texts = ["", "plain", "_x0041_", "\u0000\u0007", "\uDC00", "<&>\"'", "東京", " lead"];
      yield* Effect.forEach(
        Arr.range(0, 24),
        () =>
          Effect.gen(function* () {
            const rows = Array.from({ length: 1 + Math.floor(rand() * 5) }, () =>
              Array.from({ length: 1 + Math.floor(rand() * 5) }, () =>
                pick([
                  () => cell.text(pick(texts)),
                  () => cell.number(pick([0, -1.5, 1e300, 42])),
                  () => cell.boolean(rand() < 0.5),
                  () => cell.blank(),
                ])(),
              ),
            );
            const doc = sheetDoc([pick(["S", "a:b", "History", ""]), rows]);
            const back = worksheets(
              yield* makeXlsxReader().read(yield* makeXlsxWriter().write(doc)),
            )[0]!;
            const width = Math.max(...rows.map((r) => r.length));
            const expected = rows.map((r) =>
              Array.from({ length: width }, (_, c) => (r[c] === undefined ? "" : cellToText(r[c]))),
            );
            // Blank cells are not written, so the sheet reads back as the valued cells alone.
            expect(
              back.rows.every((r) =>
                rowEntries(r).every(([, c]) => !Predicate.isTagged(c, "CellBlank")),
              ),
            ).toBe(true);
            const backGrid = grid(back);
            const actual = expected.map((r, ri) =>
              r.map((_, ci) => {
                const c = backGrid[ri]?.[ci];
                return c === undefined ? "" : cellToText(c);
              }),
            );
            expect(actual).toEqual(expected);
            const { rows: h, columns: w } = sheetExtent(back);
            expect(h <= rows.length && w <= width).toBe(true);
          }),
        { concurrency: 1, discard: true },
      );
    }),
  );
});
