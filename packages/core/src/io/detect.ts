/**
 * Format detection for import (#188): which of the formats a caller passes
 * best explains some content, ranked, with a reason a UI can show. Each
 * format brings its own sniffer (`Format.sniff`); the core imports none, so
 * a caller pays only for the formats it passes, as with `convert`.
 */

import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Order from "effect/Order";
import * as Predicate from "effect/Predicate";
import { type Content, contentToBytes } from "./content.ts";

/** What a sniffer concluded: how sure it is (0 to 1), and why, in a few words a UI can show. */
export interface Sniff {
  /** How sure the sniffer is that the content is its format, from 0 (not at all) to 1 (certain). */
  readonly confidence: number;
  /** A short human-readable reason, such as `ZIP with xl/workbook.xml (spreadsheetml main)`. */
  readonly evidence: string;
}

/**
 * A format's recogniser (#188): `Option.some` with its confidence when the
 * content looks like the format, `Option.none` when it doesn't. It looks at
 * the content only (a file name can lie), stays within the format reader's
 * resource limits, and never throws: anything it can't decode is not its
 * format.
 */
export type Sniffer = (content: Content) => Option.Option<Sniff>;

/** What a caller knows about the content besides its bytes: tie-breakers only, never the main signal. */
export interface DetectHints {
  /** The file name, whose extension breaks ties between equally sure sniffers. */
  readonly fileName?: string | undefined;
  /** The declared MIME type, which breaks ties as the extension does. */
  readonly mimeType?: string | undefined;
}

/** The formats {@link detect} chooses among: anything with an `id` and, to be a candidate, a `sniff`. */
export interface Detectable {
  readonly id: string;
  readonly sniff?: Sniffer | undefined;
  readonly extensions?: ReadonlyArray<string> | undefined;
  readonly mimeTypes?: ReadonlyArray<string> | undefined;
}

/** One format {@link detect} thinks the content may be. */
export interface Candidate<F extends Detectable> {
  /** The format, as the caller passed it, ready for `convert` or its reader. */
  readonly format: F;
  /** The sniffer's confidence, nudged by at most {@link HINT_WEIGHT} per matching hint. */
  readonly confidence: number;
  /** Why: the sniffer's reason, plus any hint that matched. */
  readonly evidence: string;
}

/** Options for {@link detect}: the formats to choose among, and the hints. */
export interface DetectOptions<F extends Detectable> {
  readonly formats: ReadonlyArray<F>;
  readonly hints?: DetectHints | undefined;
}

/**
 * How much a matching extension or MIME type adds to a candidate's
 * confidence: enough to order two equally sure sniffers, never enough to
 * outrank a surer one, so a `.csv` that is really XLSX is detected as XLSX.
 */
export const HINT_WEIGHT = 0.001;

/** The lower-cased extension of a file name, without the dot, if it has one. */
const extensionOf = (fileName: string): string | undefined => {
  const dot = fileName.lastIndexOf(".");
  return dot <= 0 || dot === fileName.length - 1
    ? undefined
    : fileName.slice(dot + 1).toLowerCase();
};

/** A sniffer's verdict, a throwing sniffer counting as `none`: detection never fails. */
const runSniffer = (sniff: Sniffer, content: Content): Effect.Effect<Option.Option<Sniff>> =>
  Effect.sync(() => sniff(content)).pipe(
    Effect.catchDefect(() => Effect.succeed(Option.none<Sniff>())),
    Effect.map(Option.filter((s) => Number.isFinite(s.confidence) && s.confidence > 0)),
  );

const byConfidence = Order.mapInput(
  Order.flip(Order.Number),
  (c: { readonly confidence: number }) => c.confidence,
);

/**
 * The formats `content` may be, most likely first (#188). Each format's
 * sniffer judges the content alone; a matching file extension or MIME type
 * in `hints` only breaks ties ({@link HINT_WEIGHT}). Formats without a
 * sniffer, or whose sniffer says no, are left out, so the result may be
 * empty. It never fails: a sniffer that throws counts as a no.
 *
 * ```ts
 * const [best] = yield* detect(bytes(data), {
 *   formats: [Csv.format, Xlsx.format, Docx.format, Pdf.format],
 *   hints: { fileName: "report.xlsx" },
 * });
 * ```
 */
export const detect = <F extends Detectable>(
  content: Content,
  options: DetectOptions<F>,
): Effect.Effect<ReadonlyArray<Candidate<F>>> => {
  // sniffers see the same bytes: text content is encoded once
  const input: Content = Predicate.isTagged(content, "Text")
    ? content
    : { _tag: "Bytes", bytes: contentToBytes(content) };
  const ext =
    options.hints?.fileName === undefined ? undefined : extensionOf(options.hints.fileName);
  const mime = options.hints?.mimeType?.toLowerCase();
  const candidate = (format: F, s: Sniff): Candidate<F> => {
    const byExtension = ext !== undefined && (format.extensions ?? []).includes(ext);
    const byMime = mime !== undefined && (format.mimeTypes ?? []).includes(mime);
    const notes = [
      ...(byExtension ? [`extension .${ext}`] : []),
      ...(byMime ? [`MIME type ${mime}`] : []),
    ];
    return {
      format,
      confidence: Math.min(1, s.confidence + HINT_WEIGHT * notes.length),
      evidence: Arr.isReadonlyArrayEmpty(notes) ? s.evidence : `${s.evidence}; ${notes.join(", ")}`,
    };
  };
  return Effect.forEach(
    options.formats,
    (format) =>
      format.sniff === undefined
        ? Effect.succeed(Option.none<Candidate<F>>())
        : Effect.map(
            runSniffer(format.sniff, input),
            Option.map((s) => candidate(format, s)),
          ),
    { concurrency: 1 },
  ).pipe(Effect.map((verdicts) => Arr.sort(Arr.getSomes(verdicts), byConfidence)));
};
