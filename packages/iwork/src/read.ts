/**
 * What the Pages, Numbers and Keynote readers share: opening the bundle,
 * walking components object by object, and turning an `IworkError` into the
 * reader's `ParseError` without losing where it happened.
 */

import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { type Content, contentToBytes, ParseError } from "@thomasfosterau/effect-document";
import type { IworkObject } from "./archive.ts";
import { type BundleLimits, decodeComponent, type IworkBundle, openBundle } from "./bundle.ts";
import { type IworkError, isIworkError, withLocation } from "./errors.ts";

/** Options shared by the Pages, Numbers and Keynote readers. */
export interface IworkReaderOptions {
  /**
   * Skip a component that fails to decode, logging a warning
   * (`Effect.logWarning`), instead of failing the whole read. Defaults to false.
   */
  readonly lenient?: boolean | undefined;
  /** Zip-bomb limits for opening the bundle (see `BundleLimits`). */
  readonly limits?: BundleLimits | undefined;
}

/** An `IworkError` as a reader's `ParseError`; the message names the component, object and offset. */
export const toParseError = (format: string, e: IworkError): ParseError =>
  new ParseError({ format, reason: `Failed to read ${format}: ${e.message}`, cause: e });

/** Open the input as an iWork bundle. */
export const openInput = (
  format: string,
  input: Content,
  options?: IworkReaderOptions,
): Effect.Effect<IworkBundle, ParseError> =>
  Effect.suspend(() =>
    Effect.fromResult(
      Result.mapError(
        openBundle(
          contentToBytes(input),
          options?.limits === undefined ? undefined : { limits: options.limits },
        ),
        (e) => toParseError(format, e),
      ),
    ),
  );

/**
 * Decode each named component and `visit` its objects in order, collecting
 * what the visitor returns per component. A failure (in the codec or the
 * visitor) carries the component and object; in lenient mode that component
 * is skipped with a warning and left out of the result.
 */
export const eachComponent = <A>(
  format: string,
  bundle: IworkBundle,
  names: ReadonlyArray<string>,
  options: IworkReaderOptions | undefined,
  visit: (obj: IworkObject) => ReadonlyArray<A>,
): Effect.Effect<Array<ComponentItems<A>>, ParseError> =>
  Effect.forEach(
    names,
    (name): Effect.Effect<ReadonlyArray<ComponentItems<A>>, ParseError> => {
      const result = visitComponent(bundle, name, visit);
      if (Result.isSuccess(result)) return Effect.succeed([{ name, items: result.success }]);
      if (options?.lenient === true)
        return Effect.as(
          Effect.logWarning(
            `${format}: skipping a component that failed to decode: ${result.failure.message}`,
          ),
          [],
        );
      return Effect.fail(toParseError(format, result.failure));
    },
    { concurrency: 1 },
  ).pipe(Effect.map(Arr.flatten));

/** One component's visited items, from {@link eachComponent}. */
export interface ComponentItems<A> {
  readonly name: string;
  readonly items: A[];
}

const visitComponent = <A>(
  bundle: IworkBundle,
  name: string,
  visit: (obj: IworkObject) => ReadonlyArray<A>,
): Result.Result<A[], IworkError> => {
  const decoded = decodeComponent(bundle, name);
  if (Result.isFailure(decoded)) return Result.fail(decoded.failure);
  const items: A[] = [];
  for (const obj of decoded.success) {
    const visited = Result.try({ try: () => visit(obj), catch: (e) => e });
    if (Result.isFailure(visited)) {
      // only codec failures are expected here; anything else is a bug (a defect)
      if (!isIworkError(visited.failure)) throw visited.failure;
      return Result.fail(
        withLocation(visited.failure, { component: name, objectId: obj.identifier }),
      );
    }
    for (const item of visited.success) items.push(item);
  }
  return Result.succeed(items);
};
