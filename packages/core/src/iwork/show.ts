/**
 * A Keynote show's slide order (#99): `KN.DocumentArchive.show` →
 * `KN.ShowArchive.slideTree` → its slide nodes, each node's slide and then the
 * slides nested under it, depth first. Component ids are not show order, so
 * the reader sorts slide components by this instead.
 */

import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Order from "effect/Order";
import * as Result from "effect/Result";
import type { IworkObject } from "./archive.ts";
import { decodeComponent, type IworkBundle } from "./bundle.ts";
import type { IworkError } from "./errors.ts";
import { type Field, getAllBytes, getBigInt, getBytes, parseMessage } from "./protobuf.ts";
import {
  DOCUMENT_SHOW_FIELD,
  KN_DOCUMENT_ARCHIVE,
  KN_SHOW_ARCHIVE,
  KN_SLIDE_NODE_ARCHIVE,
  REFERENCE_IDENTIFIER_FIELD,
  SHOW_SLIDE_TREE_FIELD,
  SLIDE_NODE_CHILDREN_FIELD,
  SLIDE_NODE_SLIDE_FIELD,
  SLIDE_TREE_ROOT_NODE_FIELD,
  SLIDE_TREE_SLIDES_FIELD,
} from "./registry.ts";
import { makeObjectResolver, type ObjectResolver, referenceAt } from "./resolver.ts";

/** The component holding a Keynote document's root. */
const DOCUMENT_COMPONENT = "Index/Document.iwa";

/** How deep slide nodes may nest: Keynote nests slides a few levels; anything deeper is a malformed tree. */
const MAX_SLIDE_DEPTH = 64;

/** The fields of an object's message of `type`, if it has one. */
const messageOf = (obj: IworkObject, type: number): Option.Option<ReadonlyArray<Field>> =>
  Option.map(
    Arr.findFirst(obj.messages, (m) => m.type === type),
    (m) => parseMessage(m.payload),
  );

/** The identifiers every `TSP.Reference` of a repeated field names. */
const referencesAt = (fields: ReadonlyArray<Field>, n: number): ReadonlyArray<bigint> =>
  getAllBytes(fields, n).flatMap((ref) =>
    Option.toArray(
      Option.fromUndefinedOr(getBigInt(parseMessage(ref), REFERENCE_IDENTIFIER_FIELD)),
    ),
  );

/** The fields of the object `id`'s message of `type`; `None` when it is absent or of another type. */
const resolved = (
  resolver: ObjectResolver,
  id: bigint,
  type: number,
): Result.Result<Option.Option<ReadonlyArray<Field>>, IworkError> =>
  Result.map(resolver.resolve(id), (obj) => Option.flatMap(obj, (o) => messageOf(o, type)));

/** The slide ids under the slide nodes `nodes`, in show order; `seen` guards against a cycle. */
const slidesUnder = (
  resolver: ObjectResolver,
  nodes: ReadonlyArray<bigint>,
  seen: Array<bigint>,
  depth: number,
): Result.Result<ReadonlyArray<bigint>, IworkError> => {
  if (depth > MAX_SLIDE_DEPTH) return Result.succeed([]);
  return Result.map(
    Result.all(
      nodes.map((id) => {
        if (seen.includes(id)) return Result.succeed<ReadonlyArray<bigint>>([]);
        seen.push(id);
        return Result.flatMap(resolved(resolver, id, KN_SLIDE_NODE_ARCHIVE), (node) =>
          Option.match(node, {
            onNone: () => Result.succeed<ReadonlyArray<bigint>>([]),
            onSome: (fields) =>
              Result.map(
                slidesUnder(
                  resolver,
                  referencesAt(fields, SLIDE_NODE_CHILDREN_FIELD),
                  seen,
                  depth + 1,
                ),
                (children) => [
                  ...Option.toArray(referenceAt(fields, SLIDE_NODE_SLIDE_FIELD)),
                  ...children,
                ],
              ),
          }),
        );
      }),
    ),
    Arr.flatten,
  );
};

/** The top-level slide nodes of a show: `slideTree.slides`, or the deprecated root node's children. */
const topNodes = (
  resolver: ObjectResolver,
  show: ReadonlyArray<Field>,
): Result.Result<ReadonlyArray<bigint>, IworkError> => {
  const tree = Option.fromUndefinedOr(getBytes(show, SHOW_SLIDE_TREE_FIELD));
  if (Option.isNone(tree)) return Result.succeed([]);
  const fields = parseMessage(tree.value);
  const slides = referencesAt(fields, SLIDE_TREE_SLIDES_FIELD);
  if (Arr.isReadonlyArrayNonEmpty(slides)) return Result.succeed(slides);
  return Option.match(referenceAt(fields, SLIDE_TREE_ROOT_NODE_FIELD), {
    onNone: () => Result.succeed([]),
    onSome: (root) =>
      Result.map(resolved(resolver, root, KN_SLIDE_NODE_ARCHIVE), (node) =>
        Option.match(node, {
          onNone: () => [],
          onSome: (n) => referencesAt(n, SLIDE_NODE_CHILDREN_FIELD),
        }),
      ),
  });
};

/**
 * The slide ids of a Keynote bundle in show order (#99): `None` when the
 * document root, its show or its slide tree can't be found (an older or
 * partial package), so the reader falls back to component order. Fails only
 * on a component that is there but malformed.
 */
export const showOrder = (
  bundle: IworkBundle,
): Result.Result<Option.Option<ReadonlyArray<bigint>>, IworkError> =>
  Result.flatMap(decodeComponent(bundle, DOCUMENT_COMPONENT), (objects) => {
    const root = Arr.findFirst(objects, (o) =>
      o.messages.some((m) => m.type === KN_DOCUMENT_ARCHIVE),
    );
    const showId = Option.flatMap(root, (o) =>
      Option.flatMap(messageOf(o, KN_DOCUMENT_ARCHIVE), (f) => referenceAt(f, DOCUMENT_SHOW_FIELD)),
    );
    if (Option.isNone(showId)) return Result.succeed(Option.none());
    return Result.flatMap(makeObjectResolver(bundle), (resolver) =>
      Result.flatMap(resolved(resolver, showId.value, KN_SHOW_ARCHIVE), (show) =>
        Option.match(show, {
          onNone: () => Result.succeed(Option.none()),
          onSome: (fields) =>
            Result.flatMap(topNodes(resolver, fields), (nodes) =>
              Result.map(slidesUnder(resolver, nodes, [], 0), (ids) =>
                Arr.isReadonlyArrayEmpty(ids) ? Option.none() : Option.some(ids),
              ),
            ),
        }),
      ),
    );
  });

/** The slide id a slide component is named after: `Index/Slide-8060.iwa` and `Slide-8060-2.iwa` are slide 8060's. */
const SLIDE_ID = /\/Slide-(\d+)(?:-\d+)?\.iwa$/;

/**
 * Slide component paths in show order (#99): each by the position of the
 * slide it is named after (a component's identifier is its root object's, the
 * slide), components of the same slide and those of slides the show doesn't
 * list keeping their given order, the unlisted after the listed.
 */
export const inShowOrder = (
  paths: ReadonlyArray<string>,
  order: ReadonlyArray<bigint>,
): ReadonlyArray<string> => {
  const rank = (path: string): number => {
    const id = SLIDE_ID.exec(path)?.[1];
    const at = id === undefined ? -1 : order.indexOf(BigInt(id));
    return at === -1 ? order.length : at;
  };
  // a stable sort keeps the natural order within each rank
  return Arr.sort(paths, Order.mapInput(Order.Number, rank));
};
