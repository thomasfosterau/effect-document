/**
 * Profile honesty (#109): every feature in a format's write profile must
 * survive `read(write(doc))`. For each such feature a small sample document
 * exercising it is written and read back; the feature must still be used
 * (or, for the few purely textual normalisations, the text must match).
 */

import { it } from "@effect/vitest";
import * as Predicate from "effect/Predicate";
import { assert, describe, expect, test } from "vite-plus/test";
import * as Effect from "effect/Effect";
import { convert, narrow } from "@thomasfosterau/effect-document";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import {
  type Format,
  collectFeatures,
  document,
  type Feature,
  HorizontalRule,
  blocksToText,
  bytes,
  cell,
  trustAs,
  worksheet,
} from "@thomasfosterau/effect-document";
import * as Csv from "@thomasfosterau/effect-document/csv";
import { Docx, Pptx, Xlsx } from "@thomasfosterau/effect-document/ooxml";
import * as Pdf from "@thomasfosterau/effect-document/pdf";
import * as Rtf from "@thomasfosterau/effect-document/rtf";
import { type Family, sampleFor } from "../samples.ts";

/**
 * Features whose loss is a purely textual normalisation (same text, simpler
 * nodes). An unstyled blank cell is one: a sparse worksheet holds only the
 * cells it has, so XLSX writes no `<c>` for it and reads back the gap (#185).
 */
const TEXTUAL: ReadonlySet<Feature> = new Set([
  "inline.space",
  "inline.softBreak",
  "block.plain",
  "cell.blank",
]);

/** Text with whitespace runs collapsed, for comparing textual normalisations. */
const squash = (text: string) => text.replace(/\s+/g, " ").trim();

// `Format` is contravariant in its writer, so a list of formats with different
// profiles can only be typed with the profiles erased.
export const FORMATS: ReadonlyArray<readonly [Format<any, any>, Family]> = [
  [Csv.format, "sheet"],
  [Xlsx.format, "sheet"],
  [Docx.format, "prose"],
  [Pptx.format, "deck"],
  [Rtf.format, "prose"],
  [Pdf.format, "prose"],
];

describe("write profiles round-trip (#109)", () => {
  it.effect.each(FORMATS.map(([format, family]) => ({ id: format.id, format, family })))(
    "$id: every write-profile feature survives write -> read",
    ({ format, family }) =>
      Effect.gen(function* () {
        const profile = format.writeProfile;
        const lost: string[] = [];
        yield* Effect.forEach(
          profile.features,
          (feature) =>
            Effect.gen(function* () {
              if (feature.startsWith("attr.")) return;
              const doc = sampleFor(feature, family);
              if (doc === undefined) return;
              const back = yield* Effect.flatMap(format.writer!.write(trustAs(doc)), (c) =>
                format.reader!.read(c),
              );
              const kept =
                collectFeatures(back).has(feature) ||
                (TEXTUAL.has(feature) &&
                  squash(blocksToText(back.blocks)) === squash(blocksToText(doc.blocks)));
              if (!kept) lost.push(feature);
              expect(format.readProfile.is(back)).toBe(true);
            }),
          { concurrency: 1, discard: true },
        );
        expect(lost).toEqual([]);
      }),
  );
});

describe("convert reports what a writer can't preserve (#109)", () => {
  it.effect("XLSX -> XLSX reports a date cell, which the writer stores as text", () =>
    Effect.gen(function* () {
      // A workbook whose A1 is an ISO date cell (t="d"), which the reader reads as CellDate.
      const out = yield* Xlsx.makeXlsxWriter().write(
        trustAs(document([worksheet("S", [[cell.number(1)]])])),
      );
      assert(Predicate.isTagged(out, "Bytes"), "expected bytes");
      const files = unzipSync(out.bytes);
      files["xl/worksheets/sheet1.xml"] = strToU8(
        strFromU8(files["xl/worksheets/sheet1.xml"]!).replace(
          /<c r="A1"[^>]*>.*?<\/c>/,
          `<c r="A1" t="d"><v>2024-01-02T00:00:00Z</v></c>`,
        ),
      );
      const input = bytes(zipSync(files));
      const { loss } = yield* convert({ from: Xlsx.format, to: Xlsx.format, input });
      expect(loss.isLossless).toBe(false);
      expect(loss.entries.map((e) => e.feature)).toContain("cell.date");
    }),
  );

  test("narrowing to DOCX reports the rule the writer can't round-trip", () => {
    const { loss } = narrow(document([new HorizontalRule()]), Docx.format.writeProfile);
    expect(loss.entries.map((e) => e.feature)).toContain("block.horizontalRule");
  });
});
