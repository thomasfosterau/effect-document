/**
 * The codec's typed failure.
 *
 * Every layer (Snappy, IWA framing, Protobuf wire reader, archive stream,
 * bundle opener) fails with an `IworkError` and nothing else: malformed input
 * is never a `RangeError`, a silently short buffer or a bare `Error`. The error
 * carries where it happened (component path, object identifier, byte offset)
 * so a reader can report it, or skip just that component.
 */

import { Data } from "effect";
import type { ParseError } from "@thomasfosterau/effect-parse";

export type IworkErrorReason =
  /** The input is not a zip archive. */
  | "NotZip"
  /** A zip, but not an iWork package: it has no `Index/*.iwa` components (e.g. a `.docx`). */
  | "NotIwork"
  /** An iWork '09 package (`index.apxl` / `index.xml`, XML rather than IWA), not yet supported. */
  | "LegacyIwork09Unsupported"
  /** A password-protected document (a top-level `.iwph` marker). */
  | "Encrypted"
  /** A size, count or ratio limit was exceeded (a likely zip or Snappy bomb). */
  | "LimitExceeded"
  /** The data ends before a declared length. */
  | "Truncated"
  /** The data is structurally invalid. */
  | "Malformed"
  /** A package entry is missing, or reading it from a package directory failed. */
  | "Io";

export class IworkError extends Data.TaggedError("IworkError")<{
  readonly reason: IworkErrorReason;
  /** What went wrong, without the location (see `message` for both). */
  readonly detail: string;
  /** The component (e.g. "Index/Document.iwa") being decoded. */
  readonly component?: string;
  /** The archived object being decoded. */
  readonly objectId?: bigint;
  /** The byte offset of the problem, relative to the innermost input decoded. */
  readonly offset?: number;
  readonly cause?: unknown;
}> {
  override get message(): string {
    const where: string[] = [];
    if (this.component !== undefined) where.push(this.component);
    if (this.objectId !== undefined) where.push(`object ${this.objectId}`);
    if (this.offset !== undefined) where.push(`offset ${this.offset}`);
    return where.length > 0 ? `${where.join(", ")}: ${this.detail}` : this.detail;
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
  location: { readonly component?: string; readonly objectId?: bigint }
): IworkError => {
  const component = e.component ?? location.component;
  const objectId = e.objectId ?? location.objectId;
  if (component === e.component && objectId === e.objectId) return e;
  return new IworkError({
    ...fields(e),
    ...(component === undefined ? {} : { component }),
    ...(objectId === undefined ? {} : { objectId }),
  });
};

/** Convert an effect-parse error (from a framing grammar) into an `IworkError`. */
export const fromParseError = (e: ParseError.ParseError<unknown>): IworkError => {
  const what = e.description ?? `expected ${e.expected.join(" or ")}`;
  const detail = e.context.length > 0 ? `${e.context.join(" in ")}: ${what}` : what;
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
    : new IworkError({ reason: "Malformed", detail: cause instanceof Error ? cause.message : String(cause), cause });

const fields = (e: IworkError) => ({
  reason: e.reason,
  detail: e.detail,
  ...(e.component === undefined ? {} : { component: e.component }),
  ...(e.objectId === undefined ? {} : { objectId: e.objectId }),
  ...(e.offset === undefined ? {} : { offset: e.offset }),
  ...(e.cause === undefined ? {} : { cause: e.cause }),
});
