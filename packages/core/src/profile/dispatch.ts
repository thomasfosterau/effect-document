/**
 * Exhaustive dispatch on a node's `_tag` through a table of handlers, for the
 * document walks.
 *
 * `Match.valueTags` builds a matcher on every call and adds stack frames per
 * level, which the recursive `narrow` cannot afford on a document nested
 * `DEFAULT_MAX_NESTING_DEPTH` deep; a handler table costs one lookup and one
 * frame, and its mapped type still makes a missing tag a compile error.
 */

/** One handler per `_tag` of the union `U`, each receiving its own member. */
export type TagHandlers<
  U extends { readonly _tag: string },
  Args extends ReadonlyArray<unknown>,
  R,
> = {
  readonly [T in U["_tag"]]: (node: Extract<U, { readonly _tag: T }>, ...args: Args) => R;
};

/** Run the handler for `node`'s tag. */
export const dispatchTag = <
  U extends { readonly _tag: string },
  Args extends ReadonlyArray<unknown>,
  R,
>(
  handlers: TagHandlers<U, Args, R>,
  node: ByTag<U>[U["_tag"]],
  ...args: Args
): R => runHandler<U, U["_tag"], Args, R>(handlers, node._tag, node, args);

/** The member of `U` tagged `T`, by tag. */
type ByTag<U extends { readonly _tag: string }> = {
  readonly [T in U["_tag"]]: Extract<U, { readonly _tag: T }>;
};

/**
 * Run `handlers[tag]` on `node`, the member tagged `tag`: written over the
 * tag `K` so the compiler correlates the handler with its node.
 */
const runHandler = <
  U extends { readonly _tag: string },
  K extends U["_tag"],
  Args extends ReadonlyArray<unknown>,
  R,
>(
  handlers: { readonly [T in K]: (node: ByTag<U>[T], ...args: Args) => R },
  tag: K,
  node: ByTag<U>[K],
  args: Args,
): R => handlers[tag](node, ...args);
