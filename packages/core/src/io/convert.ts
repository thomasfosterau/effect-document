/**
 * The conversion pipeline - the equivalent of `pandoc -f <from> -t <to>`.
 *
 * It reads with the `from` format, then reconciles the result to the `to`
 * format's profile before writing:
 *   - if `from`'s profile is a subset of `to`'s, this is a free widening
 *     (nothing is lost);
 *   - otherwise it narrows, down-converting/dropping what `to` can't represent
 *     and reporting exactly what changed.
 * The writer therefore always receives a document it can represent.
 */

import { Effect } from "effect";
import { type Feature } from "../schema/feature.js";
import { type LossReport, narrow } from "../profile/narrow.js";
import { ConversionError, type ParseError, type WriteError } from "./errors.js";
import type { Content } from "./content.js";
import type { Format } from "./format.js";

export interface ConvertOptions<A extends Feature, B extends Feature> {
  /** Source format. */
  readonly from: Format<A>;
  /** Target format. */
  readonly to: Format<B>;
  /** Source content. */
  readonly input: Content;
}

export interface ConvertResult {
  /** The rendered target content. */
  readonly content: Content;
  /** What, if anything, was dropped or down-converted to fit the target. */
  readonly loss: LossReport;
}

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

    const source = yield* reader.read(input);
    const { document, loss } = narrow(source, to.profile);
    const content = yield* writer.write(document);
    return { content, loss };
  });
