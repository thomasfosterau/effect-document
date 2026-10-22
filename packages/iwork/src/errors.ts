/**
 * The codec's typed failure.
 *
 * Every layer (Snappy, IWA framing, Protobuf wire reader, archive stream,
 * bundle opener) fails with an `IworkError` and nothing else: malformed input
 * is never a `RangeError`, a silently short buffer or a bare `Error`. The error
 * carries where it happened (component path, object identifier, byte offset)
 * so a reader can report it, or skip just that component.
 */

import * as Arr from "effect/Array";
import * as Predicate from "effect/Predicate";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type { ParseError } from "@thomasfosterau/effect-parse";

/**
 * Why the codec failed:
 *
 * - `NotZip`: the input is not a zip archive.
 * - `NotIwork`: a zip, but not an iWork package: it has no `Index/*.iwa` components (e.g. a `.docx`).
 * - `LegacyIwork09Unsupported`: an iWork '09 package (`index.apxl` / `index.xml`, XML rather than IWA), not yet supported.
 * - `Encrypted`: a password-protected document (a top-level `.iwph` marker).
 * - `LimitExceeded`: a size, count or ratio limit was exceeded (a likely zip or Snappy bomb).
 * - `Truncated`: the data ends before a declared length.
 * - `Malformed`: the data is structurally invalid.
 * - `Io`: a package entry is missing, or reading it from a package directory failed.
 */
export const IworkErrorReason = Schema.Literals([
  "NotZip",
  "NotIwork",
  "LegacyIwork09Unsupported",
  "Encrypted",
  "LimitExceeded",
  "Truncated",
  "Malformed",
  "Io",
]);
export type IworkErrorReason = typeof IworkErrorReason.Type;

/** The codec's one failure: a reason, what went wrong, and where (see `message`). */
export class IworkError extends Schema.TaggedError<IworkError>()("IworkError", {
  reason: IworkErrorReason,
  /** What went wrong, without the location (see `message` for both). */
  detail: Schema.String,
  /** The component (e.g. "Index/Document.iwa") being decoded. */
  component: Schema.optional(Schema.String),
  /** The archived object being decoded. */
  objectId: Schema.optional(Schema.BigInt),
  /** The byte offset of the problem, relative to the innermost input decoded. */
  offset: Schema.optional(Schema.Number),
  cause: Schema.optional(Schema.Unknown),
}) {
  override get message(): string {
    const where: string[] = [];
    if (this.component !== undefined) where.push(this.component);
    if (this.objectId !== undefined) where.push(`object ${this.objectId}`);
    if (this.offset !== undefined) where.push(`offset ${this.offset}`);
    return Arr.isReadonlyArrayNonEmpty(where) ? `${where.join(", ")}: ${this.detail}` : this.detail;
  }
}

export const isIworkError = (u: unknown): u is IworkError => u instanceof IworkError;

/** Fail at an offset (a shorthand for the codec's many checks). */
export const codecError = (reason: IworkErrorReason, detail: string, offset?: number): IworkError =>
  new IworkError(offset === undefined ? { reason, detail } : { reason, detail, offset });

/** Move an error's offset by `by` bytes (an inner buffer's position in its outer one). */
export const shiftOffset = (e: IworkError, by: number): IworkError =>
  by === 0 || e.offset === undefined ? e : new IworkError({ ...fields(e), offset: e.offset + by });

/** Fill in the component / object an error happened in, keeping any already set. */
export const withLocation = (
  e: IworkError,
  location: { readonly component?: string | undefined; readonly objectId?: bigint | undefined },
): IworkError => {
  const component = e.component ?? location.component;
  const objectId = e.objectId ?? location.objectId;
  if (component === e.component && objectId === e.objectId) return e;
  return new IworkError({ ...fields(e), component, objectId });
};

/** Convert an effect-parse error (from a framing grammar) into an `IworkError`. */
export const fromParseError = (e: ParseError.ParseError<unknown>): IworkError => {
  const what = e.description ?? `expected ${e.expected.join(" or ")}`;
  const detail = Arr.isReadonlyArrayNonEmpty(e.context)
    ? `${e.context.join(" in ")}: ${what}`
    : what;
  return new IworkError({
    // running out of input (a short take, or a failure at the very end) is truncation
    reason: e.kind === "Take" || e.offset >= e.input.length ? "Truncated" : "Malformed",
    detail,
    offset: e.offset,
    cause: e,
  });
};

/** Normalise a caught value: an `IworkError` passes through, anything else becomes `Malformed`. */
export const toIworkError = (cause: unknown): IworkError =>
  isIworkError(cause)
    ? cause
    : new IworkError({
        reason: "Malformed",
        detail: describeCause(cause),
        cause,
      });

const fields = (e: IworkError) => ({
  reason: e.reason,
  detail: e.detail,
  component: e.component,
  objectId: e.objectId,
  offset: e.offset,
  cause: e.cause,
});

/** A caught value's message (every error has one), else its string form. */
export const describeCause = (cause: unknown): string =>
  Predicate.hasProperty(cause, "message") && Predicate.isString(cause.message)
    ? cause.message
    : String(cause);

/**
 * Run `f`, rethrowing a failure as `map` makes it: the synchronous codec's
 * boundary for re-positioning or classifying an inner layer's throw.
 */
export const rethrowing = <A>(f: () => A, map: (cause: unknown) => IworkError): A => {
  const result = Result.try({ try: f, catch: map });
  if (Result.isFailure(result)) throw result.failure;
  return result.success;
};
