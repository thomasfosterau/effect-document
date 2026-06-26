/**
 * effect-document
 *
 * A type-safe, profile-based universal document schema and conversion toolkit.
 *
 * - `schema/`  - the universal document AST (prose + spreadsheet + presentation),
 *                the attribute model, and the feature taxonomy.
 * - `profile/` - named subsets of the schema, phantom-typed `Doc<F>` documents,
 *                conformance checking, and the `widen`/`narrow` transforms.
 * - `io/`      - profile-typed Reader/Writer/Format abstractions, errors, and
 *                the `convert` pipeline.
 * - formats    - the `Csv` and `Xlsx` namespaces.
 *
 * ```ts
 * import { convert, text, Csv, Xlsx } from "@thomasfosterau/effect-document";
 * const { content } = yield* convert({ from: Csv.format, to: Xlsx.format, input: text("a,b\n1,2") });
 * ```
 */

// The universal document schema
export * from "./schema/index.js";

// The profile / subset system
export * from "./profile/index.js";

// The IO layer (Reader/Writer/Format, content, errors, convert)
export * from "./io/index.js";

// Format namespaces
export * as Csv from "./formats/csv/index.js";
export * as Xlsx from "./formats/xlsx/index.js";
export * as Rtf from "./formats/rtf/index.js";
export * as Docx from "./formats/docx/index.js";
export * as Pptx from "./formats/pptx/index.js";
