---
"@thomasfosterau/effect-document": minor
---

The formats are nested subpaths of this package, none of them on the root barrel: `@thomasfosterau/effect-document` itself is the schema, the profile system, the Reader/Writer/Format abstractions and `convert`, with the built-in profiles also on `./profiles` and the IO layer on `./io`.

- `@thomasfosterau/effect-document/csv`: CSV / TSV.
- `@thomasfosterau/effect-document/rtf`: RTF.
- `@thomasfosterau/effect-document/ooxml`: the `Xlsx`, `Docx` and `Pptx` namespaces, also on `./ooxml/xlsx`, `./ooxml/docx` and `./ooxml/pptx`.
- `@thomasfosterau/effect-document/pdf`: PDF, with the object layer on `./pdf/cos`.
- `@thomasfosterau/effect-document/iwork`: the `Pages`, `Numbers`, `Keynote` and container `Codec` namespaces, also on `./iwork/pages`, `./iwork/numbers`, `./iwork/keynote` and `./iwork/codec`.

`fflate` (ZIP and DEFLATE) is a dependency, reached only from `./ooxml*`, `./pdf*` and `./iwork*`. `@thomasfosterau/effect-parse` is an optional peer (`^0.4.1`), reached only from `./csv`, `./rtf`, `./ooxml*` and `./iwork*`: install it to use those. The root entry, `./schema`, `./profile`, `./profiles` and `./io` reach neither, and `./pdf` does not reach effect-parse.

```ts
import { convert } from "@thomasfosterau/effect-document";
import * as Csv from "@thomasfosterau/effect-document/csv";
import { Xlsx } from "@thomasfosterau/effect-document/ooxml";
```
