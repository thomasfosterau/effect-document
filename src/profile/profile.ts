/**
 * Profiles are named subsets of the document schema.
 *
 * Statically, a document is phantom-tagged with the union of features it is
 * permitted to contain ({@link Doc}). Because that phantom lives in a covariant
 * position, "subset of" is exactly TypeScript assignability:
 *   `Doc<A>` is assignable to `Doc<B>` iff `A` is a subset of `B`.
 * So widening is free, and passing an over-rich document to a narrower consumer
 * is a compile error.
 *
 * At runtime, a {@link Profile} carries the allowed feature set plus a validator
 * and a branded `Schema` that checks conformance (structure + subset).
 */

import { Effect, Schema } from "effect";
import { type AttrPolicy } from "../schema/attributes.js";
import { Document, type DocumentEncoded } from "../schema/document.js";
import { type Feature } from "../schema/feature.js";
import { ProfileViolation } from "../io/errors.js";
import { collectFeatures, unsupportedFeatures } from "./collect.js";

// ============================================================================
// Phantom-typed document
// ============================================================================

declare const FeatureBrand: unique symbol;

/** Phantom marker carrying the feature set a document is permitted to use. */
export interface DocBrand<out F extends Feature> {
  readonly [FeatureBrand]?: F;
}

/**
 * A `Document` statically restricted to the features `F`. The runtime value is
 * an ordinary `Document`; `F` is a compile-time-only phantom.
 */
export type Doc<F extends Feature = Feature> = Document & DocBrand<F>;

/** The feature set of a profile, as a phantom-bearing type. */
export type FeaturesOf<P> = P extends Profile<infer F> ? F : never;

// ============================================================================
// Profile
// ============================================================================

export interface Profile<F extends Feature> {
  /** Unique profile identifier (e.g. "csv", "spreadsheet", "markdown"). */
  readonly id: string;
  /** The features a conforming document may use. */
  readonly features: ReadonlySet<Feature>;
  /** Which attribute facets are allowed (derived from `features`). */
  readonly attributes: AttrPolicy;
  /** Type guard: does this document conform to the profile? */
  readonly is: (doc: Document) => doc is Doc<F>;
  /** Validate conformance, failing with the exact unsupported features. */
  readonly validate: (doc: Document) => Effect.Effect<Doc<F>, ProfileViolation>;
  /**
   * A `Schema` for documents in this profile: decoding validates both the
   * document structure and profile conformance, and yields a `Doc<F>`.
   */
  readonly schema: Schema.Schema<Doc<F>, DocumentEncoded>;
}

const attrPolicyOf = (set: ReadonlySet<Feature>): AttrPolicy => ({
  id: set.has("attr.id"),
  classes: set.has("attr.classes"),
  keyValue: set.has("attr.keyValue"),
  style: set.has("attr.style"),
});

/**
 * Define a profile from its complete allow-set of features. The same array
 * drives both the runtime feature set and the phantom type `F`, so they cannot
 * drift apart. Attribute facets are derived from the `attr.*` features present.
 *
 * ```ts
 * const csvFeatures = ["sheet.worksheet", "cell.text", "cell.number"] as const;
 * const Csv = defineProfile("csv", csvFeatures); // Profile<typeof csvFeatures[number]>
 * ```
 */
export const defineProfile = <const FS extends ReadonlyArray<Feature>>(
  id: string,
  features: FS
): Profile<FS[number]> => {
  const set: ReadonlySet<Feature> = new Set(features);
  const conforms = (doc: Document): boolean => {
    for (const f of collectFeatures(doc)) if (!set.has(f)) return false;
    return true;
  };
  const is = (doc: Document): doc is Doc<FS[number]> => conforms(doc);
  const validate = (doc: Document): Effect.Effect<Doc<FS[number]>, ProfileViolation> => {
    const unsupported = unsupportedFeatures(doc, set);
    return unsupported.length === 0
      ? Effect.succeed(doc as Doc<FS[number]>)
      : Effect.fail(new ProfileViolation({ profile: id, unsupported }));
  };
  const schema = Document.pipe(
    Schema.filter(
      (doc): boolean => conforms(doc),
      {
        identifier: `${id}Document`,
        description: `A Document conforming to the "${id}" profile`,
      }
    )
  ) as unknown as Schema.Schema<Doc<FS[number]>, DocumentEncoded>;

  return { id, features: set, attributes: attrPolicyOf(set), is, validate, schema };
};

/**
 * Assert (unsafely) that a document belongs to a profile, branding it without a
 * runtime check. Use only where a reader has already constructed the document
 * within the profile by construction.
 */
export const trustAs = <F extends Feature>(doc: Document): Doc<F> => doc as Doc<F>;
