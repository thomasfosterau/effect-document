/**
 * The Writer abstraction: intermediate representation -> format.
 *
 * A writer implements whichever write methods are natural for its format:
 * tabular formats (CSV, XLSX) implement `writeWorkbook`; document formats
 * (Markdown, HTML, ...) implement `writeDocument`. The conversion pipeline
 * bridges between the two layers when needed.
 */

import { Context, type Effect } from "effect";
import type { Document } from "../document.js";
import type { Workbook } from "../tabular.js";
import type { WriteError } from "../errors.js";
import type { Content } from "./content.js";

export interface Writer {
  /** The format this writer renders (e.g. "csv", "xlsx") */
  readonly format: string;

  /** Render a tabular Workbook to target content (tabular formats) */
  readonly writeWorkbook?: (
    workbook: Workbook
  ) => Effect.Effect<Content, WriteError>;

  /** Render a Document AST to target content (document formats) */
  readonly writeDocument?: (
    document: Document
  ) => Effect.Effect<Content, WriteError>;
}

/**
 * Create a Context tag for a format's Writer service, for dependency-injection
 * style usage. Format packages typically export a pre-made tag.
 */
export const makeWriterTag = (
  format: string
): Context.Tag<Writer, Writer> =>
  Context.GenericTag<Writer>(`@effect-document/Writer/${format}`);
