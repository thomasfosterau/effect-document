/**
 * Shared error types for all effect-pandoc readers, writers, and conversions.
 */

import { Data } from "effect";

/**
 * Raised when a reader fails to parse source content into the intermediate
 * representation.
 */
export class ParseError extends Data.TaggedError("ParseError")<{
  /** The format identifier of the reader that failed (e.g. "csv", "xlsx") */
  readonly format: string;
  readonly reason: string;
  /** Best-effort source position of the failure */
  readonly position?: {
    readonly row?: number;
    readonly column?: number;
  };
  readonly cause?: unknown;
}> {}

/**
 * Raised when a writer fails to render the intermediate representation into
 * target content.
 */
export class WriteError extends Data.TaggedError("WriteError")<{
  /** The format identifier of the writer that failed (e.g. "csv", "xlsx") */
  readonly format: string;
  readonly reason: string;
  readonly cause?: unknown;
}> {}

/**
 * Raised when content cannot be bridged between the document and tabular
 * layers of the intermediate representation, or when a conversion pipeline
 * cannot be assembled.
 */
export class ConversionError extends Data.TaggedError("ConversionError")<{
  readonly reason: string;
  readonly cause?: unknown;
}> {}
