/**
 * A `Writer<F>` renders a document into a format. Its input is typed `Doc<F>`,
 * so the compiler rejects any document richer than the format can represent -
 * callers must `narrow` (or `convert`) first. This is the "only write what a
 * format can represent" guarantee, enforced statically.
 */

import { Context, type Effect } from "effect";
import { type Doc, type Profile } from "../profile/profile.ts";
import type { Feature } from "../schema/feature.ts";
import type { WriteError } from "./errors.ts";
import type { Content } from "./content.ts";

export interface Writer<F extends Feature> {
  /** The format this writer renders (e.g. "csv", "xlsx"). */
  readonly format: string;
  /** The profile of documents this writer accepts. */
  readonly profile: Profile<F>;
  /** Render a profile-restricted document to target content. */
  readonly write: (doc: Doc<F>) => Effect.Effect<Content, WriteError>;
}

/** A `Writer` for some (existentially-quantified) profile. */
export type AnyWriter = Writer<Feature>;

/** Create a Context tag for a format's Writer service. */
export const makeWriterTag = <F extends Feature>(
  format: string
): Context.Service<Writer<F>, Writer<F>> =>
  Context.Service<Writer<F>>(`@effect-document/Writer/${format}`);
