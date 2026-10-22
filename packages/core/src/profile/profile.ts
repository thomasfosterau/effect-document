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

import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { type AttrPolicy } from "../schema/attributes.ts";
import { Document, type DocumentEncoded } from "../schema/document.ts";
import { type Feature } from "../schema/feature.ts";
import { ProfileViolation } from "../io/errors.ts";
import { unsupportedFeatures } from "./collect.ts";

// ============================================================================
// Phantom-typed document
// ============================================================================

declare const FeatureBrand: unique symbol;

/**
 * Phantom marker carrying the feature set a document is permitted to use.
 *
 * The brand is a *required* property (never assigned at runtime - the symbol is
 * `declare`d only). Requiredness is load-bearing: it makes a bare `Document`
 * (which has no brand) NOT assignable to any `Doc<F>`, so an unvalidated
 * document cannot slip into a writer. Branding happens only through the trusted
 * casts in `trustAs`/`narrow`/`widen`/profile validators.
 */
export interface DocBrand<out F extends Feature> {
  readonly [FeatureBrand]: F;
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

/** A named subset of the schema: the features it allows, its attribute policy, and the checks and schema derived from them. */
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
  readonly schema: Schema.Codec<Doc<F>, DocumentEncoded>;
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
  features: FS,
): Profile<FS[number]> => {
  const set: ReadonlySet<Feature> = new Set(features);
  const conforms = (doc: Document): boolean =>
    Arr.isReadonlyArrayEmpty(unsupportedFeatures(doc, set));
  const is = (doc: Document): doc is Doc<FS[number]> => conforms(doc);
  const validate = (doc: Document): Effect.Effect<Doc<FS[number]>, ProfileViolation> =>
    Arr.match(unsupportedFeatures(doc, set), {
      // SAFETY: the document uses no feature outside the profile's allow-set.
      onEmpty: () => Effect.succeed(doc as Doc<FS[number]>),
      onNonEmpty: (unsupported) => Effect.fail(new ProfileViolation({ profile: id, unsupported })),
    });
  const schema: Schema.Codec<Doc<FS[number]>, DocumentEncoded> = Document.pipe(
    Schema.refine(is, {
      identifier: `${id}Document`,
      title: `${id} document`,
      description: `A Document conforming to the "${id}" profile`,
    }),
  );

  return { id, features: set, attributes: attrPolicyOf(set), is, validate, schema };
};

/**
 * Assert (unsafely) that a document belongs to a profile, branding it without a
 * runtime check. Use only where a reader has already constructed the document
 * within the profile by construction.
 */
export const trustAs = <F extends Feature>(doc: Document): Doc<F> =>
  // SAFETY: the caller guarantees the document was built within the profile `F`.
  doc as Doc<F>;
