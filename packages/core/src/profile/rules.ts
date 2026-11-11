/**
 * The data structural rules beyond `notWithin` are written in (#126): where a
 * feature may appear (`OnlyWithin`) and what a node's fields may hold
 * (`FieldValues`), and the check of a node's field against a rule.
 */

import * as Predicate from "effect/Predicate";
import type { Block, Inline, Shape } from "../schema/ast.ts";
import type { Feature } from "../schema/feature.ts";

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
