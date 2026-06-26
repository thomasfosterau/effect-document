import { describe, expect, test } from "bun:test";
import { Effect, Either, Schema } from "effect";
import {
  cell, document, header, para, str, strong, worksheet,
} from "../../src/schema/index.js";
import {
  Profiles, collectFeatures, defineProfile,
} from "../../src/profile/index.js";

describe("collectFeatures", () => {
  test("reports node + attribute features used", () => {
    const doc = document([
      header(1, [str("T")]),
      para([str("x "), strong([str("y")])]),
    ]);
    const used = collectFeatures(doc);
    expect(used.has("block.header")).toBe(true);
    expect(used.has("block.para")).toBe(true);
    expect(used.has("inline.strong")).toBe(true);
    expect(used.has("inline.str")).toBe(true);
  });

  test("detects sheet.multiple and cell value features", () => {
    const doc = document([
      worksheet("A", [[cell.number(1)]]),
      worksheet("B", [[cell.boolean(true)]]),
    ]);
    const used = collectFeatures(doc);
    expect(used.has("sheet.worksheet")).toBe(true);
    expect(used.has("sheet.multiple")).toBe(true);
    expect(used.has("cell.number")).toBe(true);
    expect(used.has("cell.boolean")).toBe(true);
  });
});

describe("profile conformance", () => {
  const csvDoc = document([worksheet("S", [[cell.text("a"), cell.number(1)]])]);
  const richDoc = document([
    worksheet("S", [[cell.date(new Date())]]),
    worksheet("S2", [[cell.number(2)]]),
  ]);

  test("is: a conforming document passes", () => {
    expect(Profiles.Csv.is(csvDoc)).toBe(true);
  });

  test("is: an over-rich document fails", () => {
    // dates + multiple sheets are not in the CSV profile
    expect(Profiles.Csv.is(richDoc)).toBe(false);
  });

  test("validate: succeeds and brands a conforming document", () => {
    const r = Effect.runSync(Effect.either(Profiles.Csv.validate(csvDoc)));
    expect(Either.isRight(r)).toBe(true);
  });

  test("validate: fails with the exact unsupported features", () => {
    const r = Effect.runSync(Effect.either(Profiles.Csv.validate(richDoc)));
    expect(Either.isLeft(r)).toBe(true);
    if (Either.isLeft(r)) {
      expect(r.left._tag).toBe("ProfileViolation");
      expect(r.left.unsupported).toEqual(
        expect.arrayContaining(["cell.date", "sheet.multiple"])
      );
    }
  });

  test("profile.schema decodes a conforming document and rejects a rich one", () => {
    const mkJson = (cellJson: object) => ({
      meta: {},
      blocks: [
        { _tag: "Worksheet", name: "S", columns: [], merges: [], rows: [{ cells: [cellJson] }] },
      ],
    });
    const ok = Schema.decodeUnknownEither(Profiles.Csv.schema)(mkJson({ _tag: "CellText", value: "a" }));
    const bad = Schema.decodeUnknownEither(Profiles.Csv.schema)(
      mkJson({ _tag: "CellDate", value: "2026-06-26T00:00:00.000Z" })
    );
    expect(Either.isRight(ok)).toBe(true);
    expect(Either.isLeft(bad)).toBe(true);
  });
});

describe("defineProfile", () => {
  test("derives an attribute policy from attr.* features", () => {
    const p = defineProfile("custom", ["block.para", "inline.str", "attr.id", "attr.style"]);
    expect(p.attributes).toEqual({ id: true, classes: false, keyValue: false, style: true });
    expect(p.features.has("block.para")).toBe(true);
  });
});
