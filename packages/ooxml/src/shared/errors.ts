/**
 * Mapping OOXML package and XML failures to the toolkit's `ParseError`, keeping
 * the part name and the line/column of malformed XML.
 */

import { ParseError } from "@thomasfosterau/effect-document";
import { OpcError, XmlPartError } from "./opc.ts";

/** A reader's `ParseError` for anything thrown while reading an OOXML package. */
export const ooxmlParseError = (format: string, cause: unknown): ParseError => {
  if (cause instanceof XmlPartError) {
    const { line, column } = cause.failure.position;
    return new ParseError({
      format,
      reason: cause.message,
      position: { row: line, column },
      cause,
    });
  }
  if (cause instanceof OpcError) {
    return new ParseError({
      format,
      reason: `${cause.kind}: ${cause.message}`,
      ...(cause.kind === "LimitExceeded" ? { code: "LimitExceeded" as const } : {}),
      cause,
    });
  }
  return new ParseError({ format, reason: `Failed to parse ${format}: ${String(cause)}`, cause });
};
