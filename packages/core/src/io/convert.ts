/**
 * The conversion pipeline - the equivalent of `pandoc -f <from> -t <to>`.
 *
 * It reads with the `from` format, then reconciles the result to the `to`
 * format's write profile (what its writer preserves) before writing:
 *   - if `from`'s profile is a subset of `to`'s, this is a free widening
 *     (nothing is lost);
 *   - otherwise it narrows, down-converting/dropping what `to` can't represent
 *     and reporting exactly what changed.
 * The writer therefore always receives a document it can represent.
 */

import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import { type Feature } from "../schema/feature.ts";
import { type LossReport, lossReport } from "../profile/loss.ts";
import { narrow } from "../profile/narrow.ts";
import { ConversionError, type ParseError, type WriteError } from "./errors.ts";
import type { Content } from "./content.ts";
import { collectDiagnostics } from "./diagnostic.ts";
import type { Format } from "./format.ts";

/** Options for {@link convert}: the source and target formats, and the content to convert. */
export interface ConvertOptions<A extends Feature, B extends Feature> {
  /** Source format. */
  readonly from: Format<A, any>;
  /** Target format. */
  readonly to: Format<any, B>;
  /** Source content. */
  readonly input: Content;
  /**
   * What to do when narrowing to the target loses something (#112):
   * `"allow"` (the default) returns the content with the report, `"warn"`
   * also logs a warning per summary item (`Effect.logWarning`, annotated
   * with the formats, feature, action, severity and count), and `"fail"`
   * fails with a `ConversionError` whose `loss` is the report, like
   * `pandoc --fail-if-warnings`. The reader's diagnostics (#112) count, so
   * `"fail"` stops before writing; the writer's are known only once it has
   * run, so on one of those `"fail"` still returns no content. A `repaired`
   * diagnostic loses nothing and never fails.
   */
  readonly onLoss?: "allow" | "warn" | "fail" | undefined;
}

/** The rendered target content and what was lost getting there. */
export interface ConvertResult {
  /** The rendered target content. */
  readonly content: Content;
  /**
   * What, if anything, was dropped or down-converted to fit the target, and
   * what the reader and writer reported on the way (`loss.diagnostics`).
   */
  readonly loss: LossReport;
}

/** A loss report in a sentence: each lost feature with its count. */
const describe = (loss: LossReport): string =>
  [
    ...loss.summary.map((item) => `${item.feature} (${item.action} ×${item.count})`),
    ...loss.diagnostics
      .filter((d) => d.severity !== "repaired")
      .map((d) => `${d.code} (${d.severity}: ${d.detail})`),
  ].join(", ");

/**
 * Apply `onLoss` to `loss`: nothing when it is lossless or `"allow"`, a
 * warning per summary item for `"warn"` (a diagnostic is a warning already,
 * logged by the reader or writer that reported it), and a `ConversionError`
 * carrying the report for `"fail"`.
 */
const checkLoss = (
  loss: LossReport,
  from: string,
  to: string,
  onLoss: "allow" | "warn" | "fail",
): Effect.Effect<void, ConversionError> => {
  if (loss.isLossless || onLoss === "allow") return Effect.void;
  if (onLoss === "fail")
    return Effect.fail(
      new ConversionError({
        reason: `Converting "${from}" to "${to}" would lose ${describe(loss)}`,
        loss,
      }),
    );
  return Effect.forEach(
    loss.summary,
    (item) =>
      Effect.logWarning(
        `convert ${from} → ${to}: ${item.feature} ${item.action} ${item.count} time(s)`,
      ).pipe(
        Effect.annotateLogs({
          from,
          to,
          feature: item.feature,
          action: item.action,
          severity: item.severity,
          count: item.count,
        }),
      ),
    { concurrency: 1, discard: true },
  );
};

/** Every way `convert` can fail: reading the input, rendering the output, or a format with no reader/writer. */
export type ConvertError = ParseError | WriteError | ConversionError;

/**
 * Convert content from one format to another.
 *
 * ```ts
 * const { content, loss } = yield* convert({
 *   from: Csv.format,
 *   to: Xlsx.format,
 *   input: text("a,b\n1,2"),
 * });
 * ```
 */
export const convert = <A extends Feature, B extends Feature>({
  from,
  to,
  input,
  onLoss = "allow",
}: ConvertOptions<A, B>): Effect.Effect<ConvertResult, ConvertError> =>
  Effect.gen(function* () {
    const reader = from.reader;
    if (reader === undefined) {
      return yield* new ConversionError({
        reason: `Format "${from.id}" does not support reading`,
      });
    }
    const writer = to.writer;
    if (writer === undefined) {
      return yield* new ConversionError({
        reason: `Format "${to.id}" does not support writing`,
      });
    }

    const [source, readNotes] = yield* collectDiagnostics(reader.read(input));
    const narrowed = narrow(source, to.writeProfile);
    const document = narrowed.document;
    const beforeWrite = lossReport(narrowed.loss.entries, readNotes);
    yield* checkLoss(beforeWrite, from.id, to.id, onLoss);
    const [content, writeNotes] = yield* collectDiagnostics(writer.write(document));
    if (Arr.isReadonlyArrayEmpty(writeNotes)) return { content, loss: beforeWrite };
    const loss = lossReport(narrowed.loss.entries, [...readNotes, ...writeNotes]);
    // the writer's diagnostics are known only once it has run, and were logged
    // as it ran: only "fail" has more to do, and it still returns no content
    if (onLoss === "fail" && !lossReport([], writeNotes).isLossless)
      yield* checkLoss(loss, from.id, to.id, "fail");
    return { content, loss };
  });
