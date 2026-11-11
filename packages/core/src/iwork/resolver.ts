/**
 * The cross-component object resolver (#101): follows a `TSP.Reference` to
 * the object it names wherever that object lives, decoding each component at
 * most once and only when a lookup needs it.
 *
 * The package metadata says which component an object is in when another
 * component refers to it (`externalReferences`), and a component's identifier
 * is its root object's, so most lookups decode one component. Without a hint
 * (or without metadata) the resolver decodes the remaining components in
 * natural order until it finds the object.
 *
 * Synchronous like the rest of the codec: lookups return a `Result` failing
 * only with `IworkError`. The cache belongs to one resolver, made per read, so
 * an Effect `Cache` (a service with its own lifetime) would add a scope without
 * adding reuse.
 */

import * as Arr from "effect/Array";
import * as MutableHashMap from "effect/MutableHashMap";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import type { IworkObject } from "./archive.ts";
import { componentPaths, decodeComponent, type IworkBundle } from "./bundle.ts";
import type { IworkError } from "./errors.ts";
import type { DechunkOptions } from "./iwa.ts";
import { type PackageMetadata, readPackageMetadata } from "./metadata.ts";
import { type Field, getBigInt, getBytes, parseMessage } from "./protobuf.ts";
import { REFERENCE_IDENTIFIER_FIELD } from "./registry.ts";

/** Finds archived objects by identifier across a bundle's components. */
export interface ObjectResolver {
  /** The package metadata, when the bundle has it. */
  readonly metadata: Option.Option<PackageMetadata>;
  /** The object with `identifier`; `None` when no component holds it. */
  readonly resolve: (identifier: bigint) => Result.Result<Option.Option<IworkObject>, IworkError>;
  /** The components decoded so far (for tests and diagnostics: a resolver decodes lazily). */
  readonly decoded: () => ReadonlyArray<string>;
}

/** Where the metadata says each object lives: component roots, and the targets of external references. */
const hintsOf = (metadata: PackageMetadata): MutableHashMap.MutableHashMap<bigint, string> => {
  const pathOf = MutableHashMap.make(
    ...metadata.components.map((c) => [c.identifier, c.path] as const),
  );
  const hints = MutableHashMap.make(
    ...metadata.components.map((c) => [c.identifier, c.path] as const),
  );
  metadata.components
    .flatMap((c) => c.externalReferences)
    .forEach((ref) =>
      Option.map(
        Option.all([ref.object, MutableHashMap.get(pathOf, ref.component)]),
        ([object, path]) => MutableHashMap.set(hints, object, path),
      ),
    );
  return hints;
};

/**
 * A resolver over `bundle` (#101), reading its package metadata first. Fails
 * only when the metadata component is there but malformed.
 */
export const makeObjectResolver = (
  bundle: IworkBundle,
  options?: DechunkOptions,
): Result.Result<ObjectResolver, IworkError> =>
  Result.map(readPackageMetadata(bundle, options), (metadata) => {
    const hints = Option.match(metadata, {
      onNone: () => MutableHashMap.empty<bigint, string>(),
      onSome: hintsOf,
    });
    const objects = MutableHashMap.empty<bigint, IworkObject>();
    const order = componentPaths(bundle, () => true);
    const decoded: Array<string> = [];

    /** Decode `path` into the cache, unless it already is. */
    const load = (path: string): Result.Result<void, IworkError> => {
      if (decoded.includes(path)) return Result.void;
      return Result.map(decodeComponent(bundle, path, options), (found) => {
        decoded.push(path);
        found.forEach((o) => MutableHashMap.set(objects, o.identifier, o));
      });
    };

    /** Decode components (in natural order) until one holds `identifier`. */
    const scan = (identifier: bigint): Result.Result<Option.Option<IworkObject>, IworkError> => {
      const next = Arr.findFirst(order, (p) => !decoded.includes(p));
      if (Option.isNone(next)) return Result.succeed(Option.none());
      return Result.flatMap(load(next.value), () =>
        MutableHashMap.has(objects, identifier)
          ? Result.succeed(MutableHashMap.get(objects, identifier))
          : scan(identifier),
      );
    };

    const resolve = (identifier: bigint): Result.Result<Option.Option<IworkObject>, IworkError> => {
      const cached = MutableHashMap.get(objects, identifier);
      if (Option.isSome(cached)) return Result.succeed(cached);
      const hinted = MutableHashMap.get(hints, identifier);
      const fromHint = Option.isSome(hinted) ? load(hinted.value) : Result.void;
      return Result.flatMap(fromHint, () =>
        MutableHashMap.has(objects, identifier)
          ? Result.succeed(MutableHashMap.get(objects, identifier))
          : scan(identifier),
      );
    };

    return { metadata, resolve, decoded: () => [...decoded] };
  });

/**
 * The object identifier a `TSP.Reference` field of a message names (the
 * reference's own field 1), if the message has that field.
 */
export const referenceAt = (
  fields: ReadonlyArray<Field>,
  fieldNumber: number,
): Option.Option<bigint> =>
  Option.flatMap(Option.fromUndefinedOr(getBytes(fields, fieldNumber)), (ref) =>
    Option.fromUndefinedOr(getBigInt(parseMessage(ref), REFERENCE_IDENTIFIER_FIELD)),
  );
