/**
 * Tagged error types for readers, writers, profile checks, and conversions.
 */

import * as Schema from "effect/Schema";
import { ALL_FEATURES } from "../schema/feature.ts";

/** Best-effort source position of a parse failure. */
const SourcePosition = Schema.Struct({
  row: Schema.optional(Schema.Number),
  column: Schema.optional(Schema.Number),
});

/** A reader failed to parse source content into the document schema. */
export class ParseError extends Schema.TaggedError<ParseError>()("ParseError", {
  /** The format identifier of the reader that failed (e.g. "csv", "xlsx"). */
  format: Schema.String,
  reason: Schema.String,
  /**
   * A machine-readable failure class. `"LimitExceeded"`: the input exceeds a
   * configured resource limit (such as the maximum nesting depth) rather than
   * being malformed.
   */
  code: Schema.optional(Schema.Literal("LimitExceeded")),
  /** Best-effort source position of the failure. */
  position: Schema.optional(SourcePosition),
  cause: Schema.optional(Schema.Unknown),
}) {}

/** A writer failed to render a document into target content. */
export class WriteError extends Schema.TaggedError<WriteError>()("WriteError", {
  /** The format identifier of the writer that failed. */
  format: Schema.String,
  reason: Schema.String,
  cause: Schema.optional(Schema.Unknown),
}) {}

/**
 * A document used features outside a profile's allowed set. Carries the exact
 * offending features so callers know precisely what a target can't represent.
 */
export class ProfileViolation extends Schema.TaggedError<ProfileViolation>()("ProfileViolation", {
  /** The profile the document failed to satisfy. */
  profile: Schema.String,
  /** The features the document used that the profile does not allow (there, or where one of its `notWithin` rules keeps them out). */
  unsupported: Schema.Array(Schema.Literals(ALL_FEATURES)),
}) {
  override get message(): string {
    return `Document does not conform to profile "${this.profile}": unsupported feature(s) ${this.unsupported.join(", ")}`;
  }
}

/** A conversion pipeline could not be assembled or a bridge step failed. */
export class ConversionError extends Schema.TaggedError<ConversionError>()("ConversionError", {
  reason: Schema.String,
  cause: Schema.optional(Schema.Unknown),
}) {}
