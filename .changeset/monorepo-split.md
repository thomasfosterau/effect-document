---
"@thomasfosterau/effect-document": minor
"@thomasfosterau/effect-document-csv": minor
"@thomasfosterau/effect-document-ooxml": minor
"@thomasfosterau/effect-document-rtf": minor
"@thomasfosterau/effect-document-iwork": minor
---

Split into a monorepo: a core package plus one package per format family.

- `@thomasfosterau/effect-document` is now the core only: the schema, the
  profile system, the Reader/Writer/Format abstractions and `convert`. It no
  longer re-exports any format, and no longer depends on `fflate` or
  `@thomasfosterau/effect-parse`. The built-in profiles are also available on
  the new `./profiles` subpath, and the IO layer on `./io`.
- `@thomasfosterau/effect-document-csv`: CSV/TSV (was `./csv`).
- `@thomasfosterau/effect-document-ooxml`: `Xlsx`, `Docx` and `Pptx`
  namespaces, also on the `./xlsx`, `./docx` and `./pptx` subpaths.
- `@thomasfosterau/effect-document-rtf`: RTF (was `./rtf`).
- `@thomasfosterau/effect-document-iwork`: `Pages`, `Numbers`, `Keynote` and
  the container `Codec` namespaces, also on the `./pages`, `./numbers`,
  `./keynote` and `./codec` subpaths (the codec was `./iwork`).

Migrate imports like so:

```ts
// before
import { convert, Csv, Xlsx } from "@thomasfosterau/effect-document";
// after
import { convert } from "@thomasfosterau/effect-document";
import * as Csv from "@thomasfosterau/effect-document-csv";
import { Xlsx } from "@thomasfosterau/effect-document-ooxml";
```
