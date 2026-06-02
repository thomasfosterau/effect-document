/**
 * effect-csv (compatibility package)
 *
 * The original effect-csv API, now backed by @effect-pandoc/csv. Existing
 * imports keep working unchanged:
 *
 * ```ts
 * import { csvRead, csvWrite } from "effect-csv"
 * ```
 *
 * New projects should use @effect-pandoc/csv (and @effect-pandoc/core)
 * directly, which add typed cells, multi-sheet workbooks, and conversion to
 * other formats.
 */

export * from "@effect-pandoc/csv/legacy";
