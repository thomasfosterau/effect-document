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
import type { Block, Inline, SheetCell, Shape } from "../schema/ast.ts";
import { type Feature, featureOfTag, type TagsOf } from "../schema/feature.ts";
import { ProfileViolation } from "../io/errors.ts";
import { collectFeaturesWithin, unsupportedFeatures } from "./collect.ts";

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

/**
 * The inline nodes a `Doc<F>` may contain. A writer that renders them through
 * an exhaustive handler table (`Match.valueTags`, or a mapped type over
 * `InlineOf<F>["_tag"]`) stops compiling when a feature joins its profile
 * without a renderer, so a write profile can't claim more than its writer
 * writes (#109).
 */
export type InlineOf<F extends Feature> = Extract<Inline, { readonly _tag: TagsOf<F> }>;
/** The blocks a `Doc<F>` may contain (see {@link InlineOf}). */
export type BlockOf<F extends Feature> = Extract<Block, { readonly _tag: TagsOf<F> }>;
/** The spreadsheet cells a `Doc<F>` may contain (see {@link InlineOf}). */
export type CellOf<F extends Feature> = Extract<SheetCell, { readonly _tag: TagsOf<F> }>;
/** The slide shapes a `Doc<F>` may contain (see {@link InlineOf}). */
export type ShapeOf<F extends Feature> = Extract<Shape, { readonly _tag: TagsOf<F> }>;

/**
 * Whether `node` is a kind of node `profile` allows: an inline, block, cell or
 * shape whose feature is in it. It narrows `node` to the profile's members
 * (`InlineOf<F>`, `BlockOf<F>`, …), for a writer that renders them
 * exhaustively and treats anything else (a document it was handed through
 * `trustAs`) on its own terms.
 */
export const isNodeIn = <F extends Feature, N extends { readonly _tag: string }>(
  profile: Profile<F>,
  node: N,
): node is Extract<N, { readonly _tag: TagsOf<F> }> => {
  const feature = featureOfTag(node._tag);
  return feature !== undefined && profile.features.has(feature);
};

// ============================================================================
// Profile
// ============================================================================

/**
 * A structural rule (#126): `feature` may not appear inside a `within` node,
 * although the profile allows both on their own. For example, a format that
 * sets headings in bold can't keep `Strong` inside a `Header` (#197). A
 * document that breaks the rule doesn't conform, and `narrow` rewrites the
 * inner node as if the profile lacked `feature` there, giving `reason` in the
 * loss entry.
 */
export interface NotWithin {
  /** The feature that is not allowed inside `within`. */
  readonly feature: Feature;
  /** The block feature (e.g. `"block.header"`) whose contents may not use `feature`. */
  readonly within: Feature;
  /** Why the format can't keep it, for the loss report. */
  readonly reason: string;
}

/** Options for {@link defineProfile}: structural rules beyond the feature set. */
export interface ProfileOptions {
  /** Features the profile allows, but not inside certain nodes (see {@link NotWithin}). */
  readonly notWithin?: ReadonlyArray<NotWithin> | undefined;
}

/** A named subset of the schema: the features it allows, its attribute policy, and the checks and schema derived from them. */
export interface Profile<F extends Feature> {
  /** Unique profile identifier (e.g. "csv", "spreadsheet", "markdown"). */
  readonly id: string;
  /** The features a conforming document may use. */
  readonly features: ReadonlySet<Feature>;
  /**
   * Structural rules: features the profile allows on their own but not inside
   * certain nodes (#126). The phantom `F` can't express them, so a `Doc<F>`
   * built in code may break one; `validate` and `narrow` check them.
   */
  readonly notWithin: ReadonlyArray<NotWithin>;
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
 * `options.notWithin` adds structural rules the feature set can't express.
 *
 * ```ts
 * const csvFeatures = ["sheet.worksheet", "cell.text", "cell.number"] as const;
 * const Csv = defineProfile("csv", csvFeatures); // Profile<typeof csvFeatures[number]>
 * ```
 */
export const defineProfile = <const FS extends ReadonlyArray<Feature>>(
  id: string,
  features: FS,
  options?: ProfileOptions,
): Profile<FS[number]> => {
  const set: ReadonlySet<Feature> = new Set(features);
  const notWithin = options?.notWithin ?? [];
  /** The features a document uses outside the profile, or inside a node a rule keeps them out of. */
  const violations = (doc: Document): Feature[] =>
    Arr.dedupe([
      ...unsupportedFeatures(doc, set),
      ...notWithin
        .filter((rule) => collectFeaturesWithin(doc, rule.within).has(rule.feature))
        .map((rule) => rule.feature),
    ]);
  const conforms = (doc: Document): boolean => Arr.isReadonlyArrayEmpty(violations(doc));
  const is = (doc: Document): doc is Doc<FS[number]> => conforms(doc);
  const validate = (doc: Document): Effect.Effect<Doc<FS[number]>, ProfileViolation> =>
    Arr.match(violations(doc), {
      // SAFETY: the document uses no feature outside the profile's allow-set, and breaks none of its rules.
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

  return { id, features: set, notWithin, attributes: attrPolicyOf(set), is, validate, schema };
};

/**
 * Assert (unsafely) that a document belongs to a profile, branding it without a
 * runtime check. Use only where a reader has already constructed the document
 * within the profile by construction.
 */
export const trustAs = <F extends Feature>(doc: Document): Doc<F> =>
  // SAFETY: the caller guarantees the document was built within the profile `F`.
  doc as Doc<F>;
