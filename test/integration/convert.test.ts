import * as Predicate from "effect/Predicate";
import { assert, describe, expect, test } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Logger from "effect/Logger";
import * as References from "effect/References";
import {
  cell,
  contentToText,
  convert,
  denseRows,
  document,
  type FeaturesOf,
  text,
  trustAs,
  worksheet,
} from "@thomasfosterau/effect-document";
import * as Csv from "@thomasfosterau/effect-document/csv";
import * as Xlsx from "@thomasfosterau/effect-document/ooxml/xlsx";
import { makeXlsxReader, makeXlsxWriter } from "@thomasfosterau/effect-document/ooxml/xlsx";

type SpreadsheetF = FeaturesOf<typeof Xlsx.profile>;

const run = <A, E>(e: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(e);

describe("convert", () => {
  test("CSV -> XLSX is a free widening (lossless)", async () => {
    const { content, loss } = await run(
      convert({ from: Csv.format, to: Xlsx.format, input: text("product,price\nLaptop,999.99\n") }),
    );
    expect(content._tag).toBe("Bytes");
    expect(loss.isLossless).toBe(true);

    // sanity: the bytes are a real workbook we can read back
    const back = await run(makeXlsxReader().read(content));
    const ws = back.blocks.find((b) => Predicate.isTagged(b, "Worksheet"));
    assert(ws !== undefined && Predicate.isTagged(ws, "Worksheet"));
    const grid = denseRows(ws);
    assert(Result.isSuccess(grid));
    expect(grid.success[1]![1]).toMatchObject({
      _tag: "CellNumber",
      value: 999.99,
    });
  });

  test("XLSX -> CSV narrows, dropping nothing for representable data", async () => {
    // build an xlsx from csv, then convert back
    const { content: xlsx } = await run(
      convert({ from: Csv.format, to: Xlsx.format, input: text("a,b\n1,2\n") }),
    );
    const { content: csv, loss } = await run(
      convert({ from: Xlsx.format, to: Csv.format, input: xlsx }),
    );
    expect(contentToText(csv)).toBe("a,b\n1,2\n");
    expect(loss.isLossless).toBe(true);
  });

  test("XLSX -> CSV narrows lossily for multi-sheet input, reporting the loss", async () => {
    // a genuine two-sheet workbook
    const twoSheet = trustAs<SpreadsheetF>(
      document([
        worksheet("Jan", [[cell.text("a"), cell.number(1)]]),
        worksheet("Feb", [[cell.text("b"), cell.number(2)]]),
      ]),
    );
    const xlsx = await run(makeXlsxWriter().write(twoSheet));

    const { content: csv, loss } = await run(
      convert({ from: Xlsx.format, to: Csv.format, input: xlsx }),
    );

    expect(loss.isLossless).toBe(false);
    expect(loss.entries.some((e) => e.feature === "sheet.multiple")).toBe(true);
    // only the first sheet's data reaches CSV
    expect(contentToText(csv)).toBe("a,1\n");
  });
});

/** A two-sheet workbook: CSV keeps only the first, a loss. */
const twoSheets = () =>
  run(
    makeXlsxWriter().write(
      trustAs<SpreadsheetF>(
        document([
          worksheet("Jan", [[cell.text("a"), cell.number(1)]]),
          worksheet("Feb", [[cell.text("b"), cell.number(2)]]),
        ]),
      ),
    ),
  );

describe("convert onLoss (#112)", () => {
  test('"fail" refuses a lossy conversion with the report on the ConversionError', async () => {
    const input = await twoSheets();
    const error = await run(
      Effect.flip(convert({ from: Xlsx.format, to: Csv.format, input, onLoss: "fail" })),
    );
    assert(Predicate.isTagged(error, "ConversionError"), "expected a ConversionError");
    expect(error.reason).toContain("sheet.multiple");
    expect(error.loss?.summary).toEqual([
      expect.objectContaining({ feature: "sheet.multiple", action: "dropped", count: 1 }),
    ]);
  });

  test('"fail" lets a lossless conversion through', async () => {
    const { loss } = await run(
      convert({ from: Csv.format, to: Xlsx.format, input: text("a,b\n1,2\n"), onLoss: "fail" }),
    );
    expect(loss.isLossless).toBe(true);
  });

  test('"warn" converts and logs a warning per summary item, annotated', async () => {
    const input = await twoSheets();
    const logged: Array<{ level: string; annotations: unknown }> = [];
    const capture = Logger.make(({ logLevel, fiber }) => {
      logged.push({
        level: logLevel,
        annotations: { ...fiber.getRef(References.CurrentLogAnnotations) },
      });
    });
    const { content } = await run(
      convert({ from: Xlsx.format, to: Csv.format, input, onLoss: "warn" }).pipe(
        Effect.provide(Logger.layer([capture])),
      ),
    );
    expect(contentToText(content)).toBe("a,1\n");
    expect(logged).toEqual([
      {
        level: "Warn",
        annotations: expect.objectContaining({
          from: "xlsx",
          to: "csv",
          feature: "sheet.multiple",
          severity: "dropped-content",
          count: 1,
        }),
      },
    ]);
  });
});
