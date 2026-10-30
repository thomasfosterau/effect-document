---
"@thomasfosterau/effect-document": patch
"@thomasfosterau/effect-csv": patch
---

Tidy declarations flagged by type-aware linting, with no change in behaviour: `sheetRow`'s optional `height` parameter is declared `height?: number`, and `narrowEffect`, `synthesizeTable` and `synthesizeDocument` spell their never-failing return type `Effect<A>` instead of `Effect<A, never>`.
