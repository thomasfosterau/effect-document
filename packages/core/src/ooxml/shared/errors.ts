/**
 * Mapping OOXML package and XML failures to the toolkit's `ParseError`, keeping
 * the part name and the line/column of malformed XML.
 */

import { ParseError, type ParseErrorCode } from "../../index.ts";
import { OpcError, type OpcErrorKind, XmlPartError } from "./opc.ts";

/** The `ParseError` code of each package failure (#127). */
const OPC_CODE = {
  LimitExceeded: "LimitExceeded",
  WrongPackageType: "WrongFormat",
  MissingPart: "MissingPart",
  InvalidContainer: "InvalidContainer",
} as const satisfies Record<OpcErrorKind, ParseErrorCode>;

/** A reader's `ParseError` for anything thrown while reading an OOXML package. */
export const ooxmlParseError = (format: string, cause: unknown): ParseError => {
  if (cause instanceof XmlPartError) {
    const { line, column } = cause.failure.position;
    return new ParseError({
      format,
      reason: cause.message,
      code: "MalformedXml",
      position: { row: line, column, part: cause.part },
      cause,
    });
  }
  if (cause instanceof OpcError) {
    return new ParseError({
      format,
      reason: `${cause.kind}: ${cause.message}`,
      code: OPC_CODE[cause.kind],
      cause,
    });
  }
  return new ParseError({ format, reason: `Failed to parse ${format}: ${String(cause)}`, cause });
};
