/**
 * The Reader abstraction: format -> intermediate representation.
 *
 * A reader implements whichever read methods are natural for its format:
 * tabular formats (CSV, XLSX) implement `readWorkbook`; document formats
 * (Markdown, HTML, ...) implement `readDocument`. The conversion pipeline
 * bridges between the two layers when needed.
 */

import { Context, type Effect, type Stream } from "effect";
import type { Document } from "../document.js";
import type { Workbook } from "../tabular.js";
import type { ParseError } from "../errors.js";
import type { Content } from "./content.js";

export interface Reader {
  /** The format this reader parses (e.g. "csv", "xlsx") */
  readonly format: string;

  /** Parse source content into a tabular Workbook (tabular formats) */
  readonly readWorkbook?: (
    input: Content
  ) => Effect.Effect<Workbook, ParseError>;

  /** Parse source content into a Document AST (document formats) */
  readonly readDocument?: (
    input: Content
  ) => Effect.Effect<Document, ParseError>;

  /**
   * Stream raw rows from source content without materializing the whole
   * table (tabular formats where streaming is natural, e.g. CSV)
   */
  readonly readRowStream?: (
    input: Content
  ) => Stream.Stream<ReadonlyArray<string>, ParseError>;
}

/**
 * Create a Context tag for a format's Reader service, for dependency-injection
 * style usage. Format packages typically export a pre-made tag.
 */
export const makeReaderTag = (
  format: string
): Context.Tag<Reader, Reader> =>
  Context.GenericTag<Reader>(`@effect-document/Reader/${format}`);
