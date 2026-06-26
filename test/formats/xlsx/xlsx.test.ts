import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { cell, document, worksheet, Worksheet } from "../../../src/schema/index.js";
import { makeXlsxReader, makeXlsxWriter } from "../../../src/formats/xlsx/index.js";
import { trustAs, type Doc, type FeaturesOf } from "../../../src/profile/profile.js";
import { Spreadsheet } from "../../../src/profile/profiles.js";

const run = <A, E>(e: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(e);
type SpreadsheetF = FeaturesOf<typeof Spreadsheet>;

const worksheets = (doc: { blocks: ReadonlyArray<{ _tag: string }> }): Worksheet[] =>
  doc.blocks.filter((b) => b._tag === "Worksheet") as Worksheet[];

describe("XLSX round-trip", () => {
  test("preserves typed cells across write -> read", async () => {
    const doc = trustAs<SpreadsheetF>(
      document([
        worksheet("People", [
          [cell.text("alice"), cell.number(30), cell.boolean(true)],
          [cell.text("bob"), cell.number(25), cell.blank()],
        ]),
      ])
    );
    const xlsx = await run(makeXlsxWriter().write(doc));
    expect(xlsx._tag).toBe("Bytes");

    const back = await run(makeXlsxReader().read(xlsx));
    const ws = worksheets(back)[0]!;
    expect(ws.name).toBe("People");
    expect(ws.rows[0]!.cells[0]).toMatchObject({ _tag: "CellText", value: "alice" });
    expect(ws.rows[0]!.cells[1]).toMatchObject({ _tag: "CellNumber", value: 30 });
    expect(ws.rows[0]!.cells[2]).toMatchObject({ _tag: "CellBoolean", value: true });
  });

  test("preserves multiple sheets", async () => {
    const doc = trustAs<SpreadsheetF>(
      document([
        worksheet("A", [[cell.number(1)]]),
        worksheet("B", [[cell.number(2)]]),
      ])
    );
    const xlsx = await run(makeXlsxWriter().write(doc));
    const back = await run(makeXlsxReader().read(xlsx));
    expect(worksheets(back).map((w) => w.name)).toEqual(["A", "B"]);
  });

  test("reader output conforms to the Spreadsheet profile", async () => {
    const doc = trustAs<SpreadsheetF>(document([worksheet("S", [[cell.error("#DIV/0!")]])]));
    const xlsx = await run(makeXlsxWriter().write(doc));
    const back: Doc<SpreadsheetF> = await run(makeXlsxReader().read(xlsx));
    expect(Spreadsheet.is(back)).toBe(true);
    expect(worksheets(back)[0]!.rows[0]!.cells[0]).toMatchObject({ _tag: "CellError" });
  });
});
