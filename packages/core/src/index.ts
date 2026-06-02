/**
 * @effect-pandoc/core
 *
 * The heart of effect-pandoc: a universal intermediate representation (IR)
 * with two layers - a Pandoc-style Document AST and a tabular Workbook
 * model - plus the Reader/Writer abstractions and conversion pipeline that
 * format packages plug into.
 */

// Errors
export * from "./errors.js";

// Document AST layer
export * from "./document.js";

// Tabular layer
export * from "./tabular.js";

// Bridging between IR layers
export * from "./convert/bridge.js";

// Reader / Writer abstractions, content, formats, and the convert pipeline
export * from "./io/content.js";
export * from "./io/reader.js";
export * from "./io/writer.js";
export * from "./io/format.js";
export * from "./io/pipeline.js";
