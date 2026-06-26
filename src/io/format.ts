/**
 * A `Format<F>` bundles a format identifier, its profile, and its reader and/or
 * writer. Passing `Format` values explicitly (rather than via a global registry)
 * keeps conversions tree-shakeable and free of import side effects.
 */

import { type Profile } from "../profile/profile.js";
import type { Feature } from "../schema/feature.js";
import type { Reader } from "./reader.js";
import type { Writer } from "./writer.js";

export interface Format<F extends Feature> {
  /** Unique format identifier (e.g. "csv", "tsv", "xlsx"). */
  readonly id: string;
  /** The subset of the schema this format reads/writes. */
  readonly profile: Profile<F>;
  /** Reader implementation, if this format supports reading. */
  readonly reader?: Reader<F>;
  /** Writer implementation, if this format supports writing. */
  readonly writer?: Writer<F>;
}

/** A `Format` for some (existentially-quantified) profile. */
export type AnyFormat = Format<Feature>;
