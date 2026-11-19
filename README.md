# effect-document

A universal document schema for [Effect](https://effect.website) 4: one AST spans prose, spreadsheets and presentations, **profiles** name the subset each format supports, and converting between CSV, XLSX, DOCX, PPTX, RTF, PDF and iWork reports exactly what was lost.

> [!CAUTION]
> Experimental and pre-1.0, largely written with Claude Code. The API may change between minor versions.

## Install

```sh
pnpm add effect @thomasfosterau/effect-document @thomasfosterau/effect-parse
```

`effect` is a peer; `@thomasfosterau/effect-parse` is an optional peer, needed by `/csv`, `/rtf`, `/ooxml*` and `/iwork*`.

## Usage

```ts
import { convert, text } from "@thomasfosterau/effect-document";
import * as Csv from "@thomasfosterau/effect-document/csv";
import { Xlsx } from "@thomasfosterau/effect-document/ooxml";

// CSV ⊆ Spreadsheet, so this widening loses nothing; the reverse reports its losses.
const toXlsx = convert({ from: Csv.format, to: Xlsx.format, input: text("a,b\n1,2\n") });
```

A writer for `Doc<CsvFeature>` won't compile against a document that may hold features CSV can't represent until you `narrow` it.

## Package

| Package | Entries |
| --- | --- |
| [`@thomasfosterau/effect-document`](packages/core/README.md) | `.` (schema, profiles, pipeline), `/csv`, `/ooxml*`, `/rtf`, `/pdf*`, `/iwork*` (read-only), `/encoding` |

The [feature support matrix](packages/core/docs/formats.md) shows what each format reads and writes; runnable programs are in [`examples/`](examples).

## Docs

- [packages/core/docs/](packages/core/docs/guide.md): guides, API reference and [benchmarks](packages/core/docs/performance.md).
- [docs/CONTRIBUTING.md](docs/CONTRIBUTING.md): workflow, toolchain, guidelines and gates.
- [docs/PUBLISHING.md](docs/PUBLISHING.md), [docs/SECURITY.md](docs/SECURITY.md).
- [AGENTS.md](AGENTS.md): notes for coding agents.

## License

MIT — see [LICENSE.md](LICENSE.md).
