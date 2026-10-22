/**
 * A `Reader<F>` parses a format into a document restricted to that format's
 * profile. The return type `Doc<F>` carries the profile statically, so the
 * compiler knows exactly which subset of the schema a given format produces.
 */

import { Context, Effect, type Stream } from "effect";
import { type Doc, type Profile } from "../profile/profile.js";
import { DEFAULT_MAX_NESTING_DEPTH, nestingDepth } from "../schema/depth.js";
import type { Document } from "../schema/document.js";
import type { Feature } from "../schema/feature.js";
import { ParseError } from "./errors.js";
import type { Content } from "./content.js";

export interface Reader<F extends Feature> {
  /** The format this reader parses (e.g. "csv", "xlsx"). */
  readonly format: string;
  /** The profile this reader's output conforms to. */
  readonly profile: Profile<F>;
  /** Parse source content into a profile-restricted document. */
  readonly read: (input: Content) => Effect.Effect<Doc<F>, ParseError>;
  /**
   * Stream raw rows without materializing the whole document (tabular formats
   * where streaming is natural, e.g. CSV).
   */
  readonly readStream?: (
    input: Content
  ) => Stream.Stream<ReadonlyArray<string>, ParseError>;
}

/** A `Reader` for some (existentially-quantified) profile. */
export type AnyReader = Reader<Feature>;

/** Create a Context tag for a format's Reader service. */
export const makeReaderTag = <F extends Feature>(
  format: string
): Context.Service<Reader<F>, Reader<F>> =>
  Context.Service<Reader<F>>(`@effect-document/Reader/${format}`);

/**
 * Fail with a `"LimitExceeded"` ParseError when a document nests deeper than
 * `maxDepth` (default {@link DEFAULT_MAX_NESTING_DEPTH}); otherwise succeed
 * with it unchanged. Readers apply this to untrusted input so callers never
 * receive a document too deep for the toolkit's recursive operations.
 */
export const limitNestingDepth = <D extends Document>(
  format: string,
  doc: D,
  maxDepth: number = DEFAULT_MAX_NESTING_DEPTH
): Effect.Effect<D, ParseError> => {
  const depth = nestingDepth(doc, maxDepth);
  return depth > maxDepth
    ? Effect.fail(
        new ParseError({
          format,
          code: "LimitExceeded",
          reason: `Document nests more than ${maxDepth} levels deep (maxDepth)`,
        })
      )
    : Effect.succeed(doc);
};
