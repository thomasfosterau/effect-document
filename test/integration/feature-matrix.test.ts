/**
 * The feature × format table in `packages/core/README.md` is generated from the
 * formats' own profiles (#130), so it can't drift from the code: this test
 * renders it and fails, printing the table to paste, when the README's copy
 * between the `feature-matrix` markers differs (layout aside).
 */

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { describe, expect, test } from "vite-plus/test";
import {
  ALL_FEATURES,
  ALL_ID_FEATURES,
  type Feature,
  type Format,
} from "@thomasfosterau/effect-document";
import * as Csv from "@thomasfosterau/effect-document/csv";
import { Keynote, Numbers, Pages } from "@thomasfosterau/effect-document/iwork";
import { Docx, Pptx, Xlsx } from "@thomasfosterau/effect-document/ooxml";
import * as Pdf from "@thomasfosterau/effect-document/pdf";
import * as Rtf from "@thomasfosterau/effect-document/rtf";

const START = "<!-- feature-matrix:start -->";
const END = "<!-- feature-matrix:end -->";

/** A format's column: the features it reads and writes, `None` without a reader or writer. */
interface Column {
  readonly name: string;
  readonly read: Option.Option<ReadonlySet<Feature>>;
  readonly write: Option.Option<ReadonlySet<Feature>>;
}

/** A format as its column. */
const columnOf = <R extends Feature, W extends Feature>(
  name: string,
  format: Format<R, W>,
): Column => ({
  name,
  read: format.reader === undefined ? Option.none() : Option.some(format.readProfile.features),
  write: format.writer === undefined ? Option.none() : Option.some(format.writeProfile.features),
});

/** The formats, in the order the README lists them. */
const COLUMNS: ReadonlyArray<Column> = [
  columnOf("CSV", Csv.format),
  columnOf("TSV", Csv.tsvFormat),
  columnOf("XLSX", Xlsx.format),
  columnOf("DOCX", Docx.format),
  columnOf("PPTX", Pptx.format),
  columnOf("RTF", Rtf.format),
  columnOf("PDF", Pdf.format),
  columnOf("Keynote", Keynote.format),
  columnOf("Pages", Pages.format),
  columnOf("Numbers", Numbers.format),
];

/** Whether `features` include `feature`; for `attr.id`, `"some"` when they allow ids on some kinds of node only. */
const allows = (features: ReadonlySet<Feature>, feature: Feature): boolean | "some" =>
  feature === "attr.id" && !features.has("attr.id")
    ? ALL_ID_FEATURES.some((f) => features.has(f)) && "some"
    : features.has(feature);

/** The letter for one direction: itself, starred for some nodes only, or nothing. */
const mark = (on: boolean | "some", letter: string): string =>
  on === false ? "" : on === "some" ? `${letter}*` : letter;

/** A format's cell for `feature`: `R` read, `W` written, `*` on some nodes only, `–` neither. */
const cellFor = (column: Column, feature: Feature): string => {
  const direction = (set: Option.Option<ReadonlySet<Feature>>, letter: string) =>
    Option.match(set, { onNone: () => "", onSome: (fs) => mark(allows(fs, feature), letter) });
  const both = `${direction(column.read, "R")}${direction(column.write, "W")}`;
  return both === "" ? "–" : both;
};

/** The table, a row per feature (per-node id facets folded into `attr.id`). */
const renderMatrix = (): string => {
  const features = ALL_FEATURES.filter((f) => !ALL_ID_FEATURES.some((id) => id === f));
  const header = `| Feature | ${COLUMNS.map((c) => c.name).join(" | ")} |`;
  const rule = `| --- |${COLUMNS.map(() => " :-: |").join("")}`;
  const rows = features.map(
    (f) => `| \`${f}\` | ${COLUMNS.map((c) => cellFor(c, f)).join(" | ")} |`,
  );
  return [
    START,
    "",
    "Generated from each format's read and write profiles by `test/integration/feature-matrix.test.ts`; `R` is read, `W` written, `*` on some kinds of node only (an id on a heading, but not on every node), `–` neither.",
    "",
    header,
    rule,
    ...rows,
    "",
    END,
  ].join("\n");
};

/**
 * A table with its layout taken out: the README's copy is padded by `vp fmt`,
 * so runs of spaces and the dashes of the rule row don't count.
 */
const layoutFree = (table: string): string =>
  table
    .replace(/[ \t]+/g, " ")
    .replace(/:-+:/g, ":-:")
    .replace(/\| -+ \|/g, "| --- |");

/** The README's current copy of the table, markers included. */
const readmeMatrix = Effect.fn("readmeMatrix")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const readme = yield* fs.readFileString(
    yield* path.fromFileUrl(new URL("../../packages/core/README.md", import.meta.url)),
  );
  const from = readme.indexOf(START);
  const to = readme.indexOf(END);
  return from < 0 || to < 0 ? "" : readme.slice(from, to + END.length);
});

describe("feature × format matrix (#130)", () => {
  test("the README's table is the one the profiles give", async () => {
    const current = await Effect.runPromise(Effect.provide(readmeMatrix(), NodeServices.layer));
    expect(
      layoutFree(current),
      `paste this into packages/core/README.md (then vp fmt):\n\n${renderMatrix()}\n`,
    ).toBe(layoutFree(renderMatrix()));
  });
});
