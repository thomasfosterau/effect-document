/**
 * @thomasfosterau/effect-document
 *
 * A Pandoc-style document conversion toolkit built on Effect: readers parse
 * formats into a universal intermediate representation, writers render it
 * back out, and `convert()` connects any reader to any writer.
 *
 * The core IR (Document AST + tabular Workbook), the Reader/Writer
 * abstractions, and the `convert()` pipeline are exported at the top level.
 * Each format lives in its own namespace, since they share names like
 * `format` and `makeFormat`:
 *
 * ```ts
 * import { convert, text, Csv, Xlsx } from "@thomasfosterau/effect-document";
 * convert({ from: Csv.format, to: Xlsx.format, input: text("a,b\n1,2") });
 * ```
 *
 * The same modules are also available as subpath imports
 * (`@thomasfosterau/effect-document/csv`, `.../xlsx`, `.../legacy`).
 */

// Core IR, Reader/Writer abstractions, and the convert pipeline.
export * from "./core/index.js";

// Format modules, namespaced (each exports its own `format` / `makeFormat`).
export * as Csv from "./csv/index.js";
export * as Xlsx from "./xlsx/index.js";
