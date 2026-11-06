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
 *
 * Formats live on their own subpaths, never on this barrel, so importing
 * this entry loads no format: `@thomasfosterau/effect-document/csv`
 * (CSV/TSV), `/ooxml` (xlsx/docx/pptx), `/rtf`, `/pdf` and `/iwork`
 * (Pages/Numbers/Keynote).
 *
 * ```ts
 * import { convert, text } from "@thomasfosterau/effect-document";
 * import * as Csv from "@thomasfosterau/effect-document/csv";
 * import { Xlsx } from "@thomasfosterau/effect-document/ooxml";
 * const { content } = yield* convert({ from: Csv.format, to: Xlsx.format, input: text("a,b\n1,2") });
 * ```
 */

// The universal document schema
export * from "./schema/index.ts";

// The profile / subset system
export * from "./profile/index.ts";

// The IO layer (Reader/Writer/Format, content, errors, convert)
export * from "./io/index.ts";
