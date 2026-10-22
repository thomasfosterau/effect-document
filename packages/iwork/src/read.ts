/**
 * What the Pages, Numbers and Keynote readers share: opening the bundle,
 * walking components object by object, and turning an `IworkError` into the
 * reader's `ParseError` without losing where it happened.
 */

import { Effect, Result } from "effect";
import { type Content, contentToBytes, ParseError } from "@thomasfosterau/effect-document";
import type { IworkObject } from "./archive.ts";
import { type BundleLimits, decodeComponent, type IworkBundle, openBundle } from "./bundle.ts";
import { type IworkError, isIworkError, withLocation } from "./errors.ts";

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
): Effect.Effect<Array<{ readonly name: string; readonly items: A[] }>, ParseError> =>
  Effect.gen(function* () {
    const out: Array<{ readonly name: string; readonly items: A[] }> = [];
    for (const name of names) {
      const result = visitComponent(bundle, name, visit);
      if (Result.isSuccess(result)) {
        out.push({ name, items: result.success });
      } else if (options?.lenient === true) {
        yield* Effect.logWarning(
          `${format}: skipping a component that failed to decode: ${result.failure.message}`,
        );
      } else {
        return yield* Effect.fail(toParseError(format, result.failure));
      }
    }
    return out;
  });

const visitComponent = <A>(
  bundle: IworkBundle,
  name: string,
  visit: (obj: IworkObject) => ReadonlyArray<A>,
): Result.Result<A[], IworkError> => {
  const decoded = decodeComponent(bundle, name);
  if (Result.isFailure(decoded)) return Result.fail(decoded.failure);
  const items: A[] = [];
  for (const obj of decoded.success) {
    try {
      for (const item of visit(obj)) items.push(item);
    } catch (e) {
      // only codec failures are expected here; anything else is a bug (a defect)
      if (!isIworkError(e)) throw e;
      return Result.fail(withLocation(e, { component: name, objectId: obj.identifier }));
    }
  }
  return Result.succeed(items);
};
