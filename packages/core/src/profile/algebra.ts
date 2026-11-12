/**
 * The profile algebra (#126): profiles built from profiles, typed at the type
 * level and at runtime alike, so a format's profile can be spelled as "the
 * built-in one, without notes" instead of a hand-copied list that drifts.
 * Structural rules combine as the operation implies: a union keeps only the
 * rules both sides share (a document either side allows is allowed), an
 * intersection keeps every rule of either, and removing features drops the
 * rules about them.
 */

import * as Arr from "effect/Array";
import type { Document } from "../schema/document.ts";
import type { Feature, WithIdFeatures } from "../schema/feature.ts";
import { collectFeatures } from "./collect.ts";
import { defineProfile, type NotWithin, type Profile, type ProfileOptions } from "./profile.ts";
import type { FieldValues, OnlyWithin } from "./rules.ts";

/** Whether `A` is a sub-profile of `B` at the type level: every feature `A` allows, `B` allows too. Structural rules aren't seen here; {@link isSubProfile} checks them. */
export type IsSubProfile<A extends Profile<Feature>, B extends Profile<Feature>> = [
  A extends Profile<infer FA> ? FA : never,
] extends [B extends Profile<infer FB> ? FB : never]
  ? true
  : false;

/** A rule's identity: what it restricts, without its reason. */
const notWithinKey = (r: NotWithin): string => `${r.feature}\u0000${r.within}`;
const onlyWithinKey = (r: OnlyWithin): string =>
  `${r.feature}\u0000${r.within}\u0000${r.where?.field ?? ""}\u0000${(r.where?.oneOf ?? []).join("\u0001")}`;
const fieldValuesKey = (r: FieldValues): string =>
  `${r.feature}\u0000${r.field}\u0000${r.oneOf.join("\u0001")}`;

/** The rules of `rules` whose identity `others` also holds. */
const shared = <R>(
  rules: ReadonlyArray<R>,
  others: ReadonlyArray<R>,
  key: (r: R) => string,
): ReadonlyArray<R> => {
  const keys = others.map(key);
  return rules.filter((r) => keys.includes(key(r)));
};

/** Every rule of `a` and `b`, each identity once (`a`'s reason kept). */
const merged = <R>(
  a: ReadonlyArray<R>,
  b: ReadonlyArray<R>,
  key: (r: R) => string,
): ReadonlyArray<R> => Arr.dedupeWith([...a, ...b], (x, y) => key(x) === key(y));

/** The rules of a profile, as `defineProfile` options. */
const rulesOf = (p: Profile<Feature>): ProfileOptions => ({
  notWithin: p.notWithin,
  onlyWithin: p.onlyWithin,
  fieldValues: p.fieldValues,
});

/** A profile's features, as a list typed by its phantom: `has` is the check that makes each one an `F`. */
const listOf = <F extends Feature>(p: Profile<F>): ReadonlyArray<F> =>
  [...p.features].filter((f): f is F => p.features.has(f));

/**
 * A profile allowing what either `a` or `b` allows (#126): the union of their
 * features, keeping only the structural rules both have, since a document
 * either side accepts must be accepted.
 */
export const unionProfiles = <A extends Feature, B extends Feature>(
  id: string,
  a: Profile<A>,
  b: Profile<B>,
): Profile<WithIdFeatures<A | B>> =>
  defineProfile(id, Arr.dedupe([...listOf(a), ...listOf(b)]), {
    notWithin: shared(a.notWithin, b.notWithin, notWithinKey),
    onlyWithin: shared(a.onlyWithin, b.onlyWithin, onlyWithinKey),
    fieldValues: shared(a.fieldValues, b.fieldValues, fieldValuesKey),
  });

/**
 * A profile allowing only what both `a` and `b` allow (#126): the features
 * they share, under every structural rule of either.
 */
export const intersectProfiles = <A extends Feature, B extends Feature>(
  id: string,
  a: Profile<A>,
  b: Profile<B>,
): Profile<WithIdFeatures<Extract<A, B>>> =>
  defineProfile(
    id,
    listOf(a).filter((f): f is Extract<A, B> => b.features.has(f)),
    {
      notWithin: merged(a.notWithin, b.notWithin, notWithinKey),
      onlyWithin: merged(a.onlyWithin, b.onlyWithin, onlyWithinKey),
      fieldValues: merged(a.fieldValues, b.fieldValues, fieldValuesKey),
    },
  );

/**
 * `p` without `features` (#126), and without the structural rules about
 * them. Removing `attr.id` removes every per-node id facet with it.
 *
 * ```ts
 * const NoNotes = withoutFeatures("docx-no-notes", Docx, ["inline.note"] as const);
 * ```
 */
export const withoutFeatures = <F extends Feature, const R extends ReadonlyArray<Feature>>(
  id: string,
  p: Profile<F>,
  features: R,
): Profile<WithIdFeatures<Exclude<F, R[number]>>> => {
  const removed: ReadonlyArray<Feature> = features.includes("attr.id")
    ? [...features, ...listOf(p).filter((f) => f.startsWith("attr.id."))]
    : features;
  const keeps = (r: { readonly feature: Feature; readonly within?: Feature }) =>
    !removed.includes(r.feature) && (r.within === undefined || !removed.includes(r.within));
  return defineProfile(
    id,
    listOf(p).filter((f): f is Exclude<F, R[number]> => !removed.includes(f)),
    {
      notWithin: p.notWithin.filter(keeps),
      onlyWithin: p.onlyWithin.filter(keeps),
      fieldValues: p.fieldValues.filter(keeps),
    },
  );
};

/**
 * `p` with `features` added (#126), keeping its structural rules. Adding
 * `attr.id` adds every per-node id facet, as `defineProfile` does.
 *
 * ```ts
 * const WithNotes = extendProfile("rtf-notes", Rtf, ["inline.note"] as const);
 * ```
 */
export const extendProfile = <F extends Feature, const A extends ReadonlyArray<Feature>>(
  id: string,
  p: Profile<F>,
  features: A,
): Profile<WithIdFeatures<F | A[number]>> =>
  defineProfile(id, Arr.dedupe([...listOf(p), ...features]), rulesOf(p));

/**
 * Whether every document `a` accepts, `b` accepts too (#126): `a`'s features
 * are all `b`'s, and each of `b`'s structural rules about a feature `a`
 * allows is one of `a`'s (otherwise `a` would accept a document `b`'s rule
 * refuses). {@link IsSubProfile} is the type-level counterpart, without the
 * rules.
 */
export const isSubProfile = (a: Profile<Feature>, b: Profile<Feature>): boolean => {
  if (!listOf(a).every((f) => b.features.has(f))) return false;
  const applies = (r: { readonly feature: Feature }) => a.features.has(r.feature);
  const covered = <R extends { readonly feature: Feature }>(
    theirs: ReadonlyArray<R>,
    ours: ReadonlyArray<R>,
    key: (r: R) => string,
  ) => theirs.filter(applies).every((r) => ours.some((o) => key(o) === key(r)));
  return (
    covered(b.notWithin, a.notWithin, notWithinKey) &&
    covered(b.onlyWithin, a.onlyWithin, onlyWithinKey) &&
    covered(b.fieldValues, a.fieldValues, fieldValuesKey)
  );
};

/**
 * The smallest profile `doc` conforms to (#126): exactly the features it
 * uses, with no structural rules. Useful to ask which formats can hold a
 * document losslessly: those whose write profile it is a sub-profile of.
 */
export const profileOf = (doc: Document, id = "document"): Profile<Feature> =>
  defineProfile(id, [...collectFeatures(doc)]);
