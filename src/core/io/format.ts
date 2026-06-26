/**
 * A Format bundles a format identifier with its reader and/or writer
 * implementations. Format packages export one of these (e.g. `Csv.format`,
 * `Xlsx.format`) so callers can convert between formats without wiring
 * services themselves:
 *
 * ```ts
 * convert({ from: Csv.format, to: Xlsx.format, input: text(csvText) })
 * ```
 *
 * There is deliberately no global format registry: passing Format values
 * explicitly keeps conversions tree-shakeable and free of import side effects.
 */

import type { Reader } from "./reader.js";
import type { Writer } from "./writer.js";

export interface Format {
  /** Unique format identifier (e.g. "csv", "tsv", "xlsx") */
  readonly id: string;
  /** Reader implementation, if this format supports reading */
  readonly reader?: Reader;
  /** Writer implementation, if this format supports writing */
  readonly writer?: Writer;
}
