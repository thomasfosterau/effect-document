/**
 * The diagnostics channel (#112, owner decision: option 3): readers and
 * writers report non-fatal issues as annotated warning log records, and
 * `convert` collects them into its report.
 */

import { layer } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Logger from "effect/Logger";
import * as Path from "effect/Path";
import * as Predicate from "effect/Predicate";
import { unzipSync, zipSync } from "fflate";
import { assert, describe, expect, test } from "vite-plus/test";
import {
  bytes,
  cell,
  collectDiagnostics,
  convert,
  type Diagnostic,
  document,
  type FeaturesOf,
  type Format,
  logDiagnostic,
  lossReport,
  trustAs,
  worksheet,
} from "@thomasfosterau/effect-document";
import { Keynote } from "@thomasfosterau/effect-document/iwork";
import * as Xlsx from "@thomasfosterau/effect-document/ooxml/xlsx";

const note = (code: string, severity: Diagnostic["severity"]): Diagnostic => ({
  format: "test",
  stage: "read",
  code,
  severity,
  path: [],
  detail: code,
});

layer(NodeServices.layer)((it) => {
  describe("collectDiagnostics (#112)", () => {
    it.effect(
      "gathers reported diagnostics in order, ignores other logs, and leaves the loggers alone",
      () =>
        Effect.gen(function* () {
          const seen: Array<unknown> = [];
          const existing = Logger.make(({ message }) => {
            seen.push(message);
          });
          const [value, found] = yield* collectDiagnostics(
            Effect.gen(function* () {
              yield* logDiagnostic(note("test.first", "converted"));
              yield* Effect.logWarning("not a diagnostic");
              yield* logDiagnostic(note("test.second", "repaired"));
              return 42;
            }),
          ).pipe(Effect.withLogger(existing));
          expect(value).toBe(42);
          expect(found.map((d) => d.code)).toEqual(["test.first", "test.second"]);
          expect(seen).toHaveLength(3);
        }),
    );

    test("a report is lossless with only repaired diagnostics", () => {
      expect(lossReport([], [note("test.fixed", "repaired")]).isLossless).toBe(true);
      expect(lossReport([], [note("test.lost", "dropped-content")]).isLossless).toBe(false);
    });
  });

  /** A sheet whose numbers SpreadsheetML can't hold, under names Excel refuses. */
  const AWKWARD = document([
    worksheet("a/b", [[cell.number(Number.NaN), cell.number(1), cell.number(Infinity)]]),
    worksheet("Data", [[cell.text("x")]]),
    worksheet("data", [[cell.text("y")]]),
  ]);

  describe("XLSX writer diagnostics (#112, from #61)", () => {
    it.effect("reports each non-finite number written as #NUM! and each renamed sheet", () =>
      Effect.gen(function* () {
        const [, found] = yield* collectDiagnostics(Xlsx.makeXlsxWriter().write(trustAs(AWKWARD)));
        expect(found.map((d) => [d.code, d.path])).toEqual([
          ["xlsx.sheetRenamed", ["a/b"]],
          ["xlsx.sheetRenamed", ["data"]],
          ["xlsx.nonFiniteNumber", ["a/b", "A1"]],
          ["xlsx.nonFiniteNumber", ["a/b", "C1"]],
        ]);
        expect(found[0]?.detail).toContain('"a_b"');
        expect(found[1]?.detail).toContain('"data (2)"');
        expect(found.every((d) => d.stage === "write" && d.severity === "converted")).toBe(true);
      }),
    );

    it.effect("a clean workbook reports nothing", () =>
      Effect.gen(function* () {
        const [, found] = yield* collectDiagnostics(
          Xlsx.makeXlsxWriter().write(trustAs(document([worksheet("S", [[cell.number(1)]])]))),
        );
        expect(found).toEqual([]);
      }),
    );
  });

  /** A format whose reader returns {@link AWKWARD} whatever it is given. */
  const awkwardSource: Format<FeaturesOf<typeof Xlsx.profile>> = {
    id: "awkward",
    readProfile: Xlsx.profile,
    writeProfile: Xlsx.profile,
    reader: {
      format: "awkward",
      profile: Xlsx.profile,
      read: () => Effect.succeed(trustAs(AWKWARD)),
    },
  };

  describe("convert collects diagnostics (#112)", () => {
    it.effect("the writer's diagnostics are in the report, which is then not lossless", () =>
      Effect.gen(function* () {
        const { loss } = yield* convert({
          from: awkwardSource,
          to: Xlsx.format,
          input: bytes(new Uint8Array()),
        });
        expect(loss.entries).toEqual([]);
        expect(loss.diagnostics.map((d) => d.code)).toEqual([
          "xlsx.sheetRenamed",
          "xlsx.sheetRenamed",
          "xlsx.nonFiniteNumber",
          "xlsx.nonFiniteNumber",
        ]);
        expect(loss.isLossless).toBe(false);
      }),
    );

    it.effect('"fail" fails on a writer diagnostic, carrying the whole report', () =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(
          convert({
            from: awkwardSource,
            to: Xlsx.format,
            input: bytes(new Uint8Array()),
            onLoss: "fail",
          }),
        );
        assert(Predicate.isTagged(error, "ConversionError"), "expected a ConversionError");
        expect(error.reason).toContain("xlsx.nonFiniteNumber");
        expect(error.loss?.diagnostics).toHaveLength(4);
      }),
    );
  });

  /** The Keynote fixture with one slide's component cut to a few bytes. */
  const brokenKeynote = Effect.fn("brokenKeynote")(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const data = yield* fs.readFile(
      yield* path.fromFileUrl(
        new URL("../../packages/core/test/iwork/fixtures/simple-oneslide.key", import.meta.url),
      ),
    );
    const files = unzipSync(data);
    return zipSync({ ...files, "Index/Slide-8060.iwa": new Uint8Array([0, 0x40, 0]) });
  });

  describe("iWork reader diagnostics (#112)", () => {
    it.effect("a lenient read reports the component it skipped", () =>
      Effect.gen(function* () {
        const input = bytes(yield* brokenKeynote());
        const [, found] = yield* collectDiagnostics(
          Keynote.makeKeynoteReader({ lenient: true }).read(input),
        );
        expect(found).toEqual([
          expect.objectContaining({
            format: "keynote",
            stage: "read",
            code: "iwork.componentSkipped",
            severity: "dropped-content",
            path: [expect.stringContaining("Slide-8060")],
          }),
        ]);
      }),
    );
  });
});
