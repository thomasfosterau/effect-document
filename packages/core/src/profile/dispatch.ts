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
  node: U,
  ...args: Args
): R => {
  // SAFETY: the mapped type gives the entry at `node._tag` the parameter
  // `Extract<U, { _tag: typeof node._tag }>`, which is exactly `node`'s member
  const handler = handlers[node._tag as U["_tag"]] as (node: U, ...args: Args) => R;
  return handler(node, ...args);
};
