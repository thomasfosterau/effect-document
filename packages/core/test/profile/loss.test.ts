import * as Schema from "effect/Schema";
import * as DateTime from "effect/DateTime";
import { describe, expect, test } from "vite-plus/test";
import {
  cell,
  document,
  header,
  para,
  slide,
  slideShow,
  str,
  strong,
  textBox,
  worksheet,
} from "../../src/schema/index.ts";
import {
  LOSS_SUMMARY_PATHS,
  LossReport,
  Profiles,
  defineProfile,
  lossReport,
  narrow,
} from "../../src/profile/index.ts";

const day = cell.date(DateTime.toDateUtc(DateTime.makeUnsafe("2026-01-02T00:00:00Z")));

describe("loss report paths, severity and summary (#112)", () => {
  test("a cell's entry names its block and A1 address", () => {
    const doc = document([
      para([str("intro")]),
      worksheet("S", [
        [cell.text("when"), cell.text("what")],
        [day, cell.text("x")],
        [cell.text("y"), day],
      ]),
    ]);
    const { loss } = narrow(doc, Profiles.Csv);
    const dates = loss.entries.filter((e) => e.feature === "cell.date");
    expect(dates.map((e) => e.path)).toEqual([
      [1, "A2"],
      [1, "B3"],
    ]);
    expect(dates.every((e) => e.severity === "converted")).toBe(true);
  });

  test("columns past Z get two letters", () => {
    const row = [...Array.from({ length: 27 }, () => cell.text("x")), day];
    const { loss } = narrow(document([worksheet("S", [row])]), Profiles.Csv);
    expect(loss.entries.find((e) => e.feature === "cell.date")?.path).toEqual([0, "AB1"]);
  });

  test("slide content and speaker notes are located by slide and shape", () => {
    const NoNotes = defineProfile("no-notes", [
      "deck.slideShow",
      "shape.textBox",
      "block.para",
      "inline.str",
    ]);
    const doc = document([
      slideShow([
        slide([textBox([para([str("a")])])]),
        slide([textBox([para([str("b")]), header(1, [str("H")])])], [para([str("n")])]),
      ]),
    ]);
    const { loss } = narrow(doc, NoNotes);
    expect(loss.entries.map((e) => [e.feature, e.severity, e.path])).toEqual([
      ["deck.notes", "dropped-content", [0, 1, "notes"]],
      ["block.header", "converted", [0, 1, 0, 1]],
    ]);
  });

  test("an inline's entry names its block and position", () => {
    const { loss } = narrow(
      document([para([str("a")]), para([str("b "), strong([str("c")])])]),
      defineProfile("plain", ["block.para", "inline.str"]),
    );
    expect(loss.entries).toEqual([
      expect.objectContaining({ feature: "inline.strong", severity: "converted", path: [1, 1] }),
    ]);
  });

  test("the summary groups entries by feature and action, keeping the first few paths", () => {
    const rows = Array.from({ length: 7 }, () => [day]);
    const { loss } = narrow(document([worksheet("S", rows)]), Profiles.Csv);
    expect(loss.summary).toEqual([
      {
        feature: "cell.date",
        action: "converted",
        severity: "converted",
        count: 7,
        paths: Array.from({ length: LOSS_SUMMARY_PATHS }, (_, i) => [0, `A${i + 1}`]),
      },
    ]);
  });

  test("a lossless narrowing has an empty summary", () => {
    const report = narrow(document([para([str("a")])]), Profiles.Full).loss;
    expect(report).toEqual({ entries: [], summary: [], isLossless: true });
    expect(lossReport([])).toEqual(report);
  });

  test("a report encodes to JSON and decodes back", () => {
    const { loss } = narrow(document([worksheet("S", [[day]])]), Profiles.Csv);
    const Json = Schema.fromJsonString(LossReport);
    const json = Schema.encodeSync(Json)(loss);
    expect(json).toContain('"path":[0,"A1"]');
    expect(Schema.decodeSync(Json)(json)).toEqual(loss);
  });
});
