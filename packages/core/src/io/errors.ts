/**
 * Tagged error types for readers, writers, profile checks, and conversions.
 */

import { Data } from "effect";
import type { Feature } from "../schema/feature.ts";

/** A reader failed to parse source content into the document schema. */
export class ParseError extends Data.TaggedError("ParseError")<{
  /** The format identifier of the reader that failed (e.g. "csv", "xlsx"). */
  readonly format: string;
  readonly reason: string;
  /**
   * A machine-readable failure class. `"LimitExceeded"`: the input exceeds a
   * configured resource limit (such as the maximum nesting depth) rather than
   * being malformed.
   */
  readonly code?: "LimitExceeded" | undefined;
  /** Best-effort source position of the failure. */
  readonly position?: {
    readonly row?: number | undefined;
    readonly column?: number | undefined;
  };
  readonly cause?: unknown | undefined;
}> {}

/** A writer failed to render a document into target content. */
export class WriteError extends Data.TaggedError("WriteError")<{
  /** The format identifier of the writer that failed. */
  readonly format: string;
  readonly reason: string;
  readonly cause?: unknown | undefined;
}> {}

/**
 * A document used features outside a profile's allowed set. Carries the exact
 * offending features so callers know precisely what a target can't represent.
 */
export class ProfileViolation extends Data.TaggedError("ProfileViolation")<{
  /** The profile the document failed to satisfy. */
  readonly profile: string;
  /** The features the document used that the profile does not allow. */
  readonly unsupported: ReadonlyArray<Feature>;
}> {
  override get message(): string {
    return `Document does not conform to profile "${this.profile}": unsupported feature(s) ${this.unsupported.join(", ")}`;
  }
}

/** A conversion pipeline could not be assembled or a bridge step failed. */
export class ConversionError extends Data.TaggedError("ConversionError")<{
  readonly reason: string;
  readonly cause?: unknown | undefined;
}> {}
