---
"@thomasfosterau/effect-document": minor
---

Replace the two-layer IR (Document AST + tabular Workbook + legacy effect-csv shim) with a single, type-safe **profile-based universal document schema**.

- **One schema** spanning prose, spreadsheets (a `Worksheet` block of typed cells), and presentations (a `SlideShow` block) — a Pandoc-superset with a structured + open attribute model.
- **Profiles** are named subsets of the schema. Documents are phantom-typed `Doc<F>` so "subset of" is ordinary TypeScript assignability: readers return exactly their format's subset, and writers reject (at compile time) any document too rich to represent.
- **`narrow`/`widen`** transform documents between subsets — widening is free, narrowing is lossy and reports exactly what was dropped or down-converted. **`convert`** widens or narrows automatically and returns a loss report.
- CSV and XLSX are retrofitted onto the new schema (`Csv`/`Xlsx` profiles).

Breaking: the old `Workbook`/`Sheet`/`Cell` IR, the `convert()` return shape (now `{ content, loss }`), and the `/legacy` entry point are removed. New subpath entry points `/schema` and `/profile` are added.
