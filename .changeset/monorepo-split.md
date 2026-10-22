---
"@thomasfosterau/effect-document": minor
"@thomasfosterau/effect-csv": minor
"@thomasfosterau/effect-ooxml": minor
"@thomasfosterau/effect-rtf": minor
"@thomasfosterau/effect-iwork": minor
---

Split into a monorepo: a core package plus one package per format family.

- `@thomasfosterau/effect-document` is now the core only: the schema, the profile system, the Reader/Writer/Format abstractions and `convert`. It no longer re-exports any format, and no longer depends on `fflate` or `@thomasfosterau/effect-parse`. The built-in profiles are also available on the new `./profiles` subpath, and the IO layer on `./io`.
- `@thomasfosterau/effect-csv`: CSV/TSV (was `./csv`).
- `@thomasfosterau/effect-ooxml`: `Xlsx`, `Docx` and `Pptx` namespaces, also on the `./xlsx`, `./docx` and `./pptx` subpaths.
- `@thomasfosterau/effect-rtf`: RTF (was `./rtf`).
- `@thomasfosterau/effect-iwork`: `Pages`, `Numbers`, `Keynote` and the container `Codec` namespaces, also on the `./pages`, `./numbers`, `./keynote` and `./codec` subpaths (the codec was `./iwork`).

Migrate imports like so:

```ts
// before
import { convert, Csv, Xlsx } from "@thomasfosterau/effect-document";
// after
import { convert } from "@thomasfosterau/effect-document";
import * as Csv from "@thomasfosterau/effect-csv";
import { Xlsx } from "@thomasfosterau/effect-ooxml";
```
