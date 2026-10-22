/**
 * A `Format<R, W>` bundles a format identifier, its read and write profiles,
 * and its reader and/or writer. The two profiles differ when a reader produces
 * features its writer can't preserve (or vice versa); `W` defaults to `R`. Passing `Format` values explicitly (rather than via a global registry)
 * keeps conversions tree-shakeable and free of import side effects.
 */

import { type Profile } from "../profile/profile.js";
import type { Feature } from "../schema/feature.js";
import type { Reader } from "./reader.js";
import type { Writer } from "./writer.js";

export interface Format<R extends Feature, W extends Feature = R> {
  /** Unique format identifier (e.g. "csv", "tsv", "xlsx"). */
  readonly id: string;
  /** The subset of the schema this format's reader produces. */
  readonly readProfile: Profile<R>;
  /**
   * The subset of the schema this format's writer *preserves*: every feature
   * in it survives `read(write(doc))`. `convert` narrows to it, so a feature
   * the writer would silently drop or downgrade is reported as a loss.
   */
  readonly writeProfile: Profile<W>;
  /** Reader implementation, if this format supports reading. */
  readonly reader?: Reader<R>;
  /** Writer implementation, if this format supports writing. */
  readonly writer?: Writer<W>;
}

/** A `Format` for some (existentially-quantified) profiles. */
export type AnyFormat = Format<Feature, Feature>;
