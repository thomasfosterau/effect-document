/**
 * The data structural rules beyond `notWithin` are written in (#126): where a
 * feature may appear (`OnlyWithin`), what a node's fields may hold
 * (`FieldValues`) and a feature that must be the whole of a node's content
 * (`Whole`, #67), and the checks of a node against a rule.
 */

import * as Predicate from "effect/Predicate";
import type { Block, Inline, Shape } from "../schema/ast.ts";
import { type Feature, featureOfTag } from "../schema/feature.ts";

/** A value a structural rule compares a node's field with: a string, number or boolean. */
export type RuleValue = string | number | boolean;

/** A condition on one of a node's own fields: it holds one of `oneOf`. */
export interface FieldMatch {
  /** The node's field, e.g. `"level"` on a `Header`, `"placeholderType"` on a `Placeholder`. */
  readonly field: string;
  /** The values that satisfy the condition, compared with `===`. */
  readonly oneOf: ReadonlyArray<RuleValue>;
}

/**
 * A structural rule (#126): `feature` may appear only inside a `within` node
 * (one whose fields also satisfy `where`, when given), although the profile
 * allows both. For example, PPTX keeps a heading only as a slide's title, in
 * a title placeholder (#196). A document with the feature anywhere else
 * doesn't conform, and `narrow` rewrites it there as if the profile lacked
 * it, giving `reason` in the loss entry.
 */
export interface OnlyWithin {
  /** The feature that is allowed only inside `within`. */
  readonly feature: Feature;
  /** The block or shape feature (e.g. `"shape.placeholder"`) that may contain `feature`. */
  readonly within: Feature;
  /** A condition on the `within` node's own fields; without it, any such node will do. */
  readonly where?: FieldMatch | undefined;
  /** Why the format can't keep it elsewhere, for the loss report. */
  readonly reason: string;
}

/**
 * A structural rule (#126): a node of `feature` must have its field `field`
 * holding one of `oneOf`. For example, PPTX keeps a heading only at level 1
 * (#196). A node with another value doesn't conform, and `narrow` rewrites it
 * as if the profile lacked `feature`, giving `reason` in the loss entry.
 */
export interface FieldValues extends FieldMatch {
  /** The node feature (e.g. `"block.header"`) whose field is restricted. */
  readonly feature: Feature;
  /** Why the format can't keep other values, for the loss report. */
  readonly reason: string;
}

/** A node a structural rule can name: a block, an inline or a slide shape. */
export type RuleNode = Block | Inline | Shape;

/** Whether `node`'s own field `match.field` holds one of `match.oneOf`. */
export const fieldMatches = (node: RuleNode, match: FieldMatch): boolean => {
  if (!Predicate.hasProperty(node, match.field)) return false;
  const value = node[match.field];
  return match.oneOf.some((v) => v === value);
};

/**
 * The nodes a {@link Whole} rule can name as its container: those whose
 * content is a run of inlines that `narrow` and the conformance check look
 * into. A rich cell's runs (`cell.richText`) for now; a new container is added
 * here and to both.
 */
export type WholeContainer = "cell.richText";

/**
 * A structural rule (#67): inside a `within` node, `feature` appears only as
 * that node's whole content, the one top-level node of its content with no
 * other node of `feature` inside it. For example, XLSX links a whole cell,
 * never part of its text, so a `Link` in a rich cell must be the cell's only
 * run. A document that breaks it doesn't conform, and `narrow` widens the
 * first such node over the whole content (keeping its target, unwrapping the
 * others), giving `reason` in the loss entry.
 */
export interface Whole {
  /** The inline feature that must be its container's whole content (e.g. `"inline.link"`). */
  readonly feature: Feature;
  /** The container (see {@link WholeContainer}). */
  readonly within: WholeContainer;
  /** Why the format can't keep it over only part of the content, for the loss report. */
  readonly reason: string;
}

/** An inline's child inlines: its `content`, when it holds inlines; none otherwise. */
export const childInlines = (inline: Inline): ReadonlyArray<Inline> =>
  Predicate.hasProperty(inline, "content") && Array.isArray(inline.content)
    ? inline.content.filter((c): c is Inline => Predicate.hasProperty(c, "_tag"))
    : [];

/** How many nodes of `feature` `inlines` hold, at any depth. */
const countOf = (inlines: ReadonlyArray<Inline>, feature: Feature): number =>
  inlines.reduce(
    (n, inline) =>
      n + (featureOfTag(inline._tag) === feature ? 1 : 0) + countOf(childInlines(inline), feature),
    0,
  );

/**
 * Whether `content` (a `rule.within` node's inlines) breaks `rule`: it holds a
 * node of `rule.feature` anywhere but as its one top-level node, alone.
 */
export const breaksWhole = (content: ReadonlyArray<Inline>, rule: Whole): boolean => {
  const count = countOf(content, rule.feature);
  if (count === 0) return false;
  const [only] = content;
  return !(
    content.length === 1 &&
    only !== undefined &&
    featureOfTag(only._tag) === rule.feature &&
    count === 1
  );
};
