/**
 * Tagged error types for readers, writers, profile checks, and conversions.
 */

import * as Schema from "effect/Schema";
import { ALL_FEATURES } from "../schema/feature.ts";

/**
 * Best-effort source position of a parse failure (#127): as much of it as the
 * reader knows. `row` and `column` are counted as the format counts them: a
 * CSV source row and column from 0, an XML part's line and column from 1;
 * `part` is a package part (`word/document.xml`), `offset` a
 * byte offset (in the part or component when one is given, else in the
 * input), `component` and `object` an iWork component and archived object,
 * and `sheet` / `cell` a worksheet and an A1 address.
 */
export const SourcePosition = Schema.Struct({
  row: Schema.optional(Schema.Number),
  column: Schema.optional(Schema.Number),
  part: Schema.optional(Schema.String),
  offset: Schema.optional(Schema.Int),
  component: Schema.optional(Schema.String),
  object: Schema.optional(Schema.String),
  sheet: Schema.optional(Schema.String),
  cell: Schema.optional(Schema.String),
});
/** Best-effort source position of a parse failure, as a type. */
export type SourcePosition = typeof SourcePosition.Type;

/**
 * What kind of failure a {@link ParseError} is (#127), shared by every reader
 * so a caller can branch on it rather than on the message:
 * - `InvalidContainer`: the archive itself is unreadable (not a zip);
 * - `WrongFormat`: a valid container or file of another format (a DOCX read
 *   as XLSX, a zip that isn't iWork, text that isn't RTF);
 * - `MissingPart`: a part the format requires is absent or unresolvable;
 * - `Encrypted`: password-protected input, which no reader decrypts;
 * - `MalformedXml`: an XML part that doesn't parse (`position` has the part,
 *   line and column);
 * - `MalformedBinary`: a binary structure that doesn't decode (a PDF object,
 *   an iWork chunk, a truncated stream);
 * - `MalformedText`: a text format's syntax (a CSV quote, an RTF control);
 * - `LimitExceeded`: the input breaks a configured resource limit (nesting
 *   depth, cells, zip sizes) rather than being malformed;
 * - `Unsupported`: well-formed input in a variant no reader handles (iWork '09).
 */
export const ParseErrorCode = Schema.Literals([
  "InvalidContainer",
  "WrongFormat",
  "MissingPart",
  "Encrypted",
  "MalformedXml",
  "MalformedBinary",
  "MalformedText",
  "LimitExceeded",
  "Unsupported",
]);
/** What kind of failure a {@link ParseError} is, as a type. */
export type ParseErrorCode = typeof ParseErrorCode.Type;

/** A reader failed to parse source content into the document schema. */
export class ParseError extends Schema.TaggedError<ParseError>()("ParseError", {
  /** The format identifier of the reader that failed (e.g. "csv", "xlsx"). */
  format: Schema.String,
  reason: Schema.String,
  /**
   * A machine-readable failure class (see {@link ParseErrorCode}); absent
   * when a reader can't classify the failure.
   */
  code: Schema.optional(ParseErrorCode),
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
