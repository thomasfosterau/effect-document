/**
 * A `Reader<F>` parses a format into a document restricted to that format's
 * profile. The return type `Doc<F>` carries the profile statically, so the
 * compiler knows exactly which subset of the schema a given format produces.
 */

import { Context, type Effect, type Stream } from "effect";
import { type Doc, type Profile } from "../profile/profile.js";
import type { Feature } from "../schema/feature.js";
import type { ParseError } from "./errors.js";
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
): Context.Tag<Reader<F>, Reader<F>> =>
  Context.GenericTag<Reader<F>>(`@effect-document/Reader/${format}`);
