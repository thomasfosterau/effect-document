# @thomasfosterau/effect-document

A type-safe, profile-based universal document schema for [Effect](https://effect.website) 4: one AST for prose, spreadsheets and presentations, **profiles** that name subsets of it, readers and writers typed by their format's profile, and conversion that reports exactly what was lost.

> [!CAUTION]
> Experimental and pre-1.0, largely written with Claude Code. The API may change between minor versions.

## Install

```sh
pnpm add effect @thomasfosterau/effect-document
# for /csv, /rtf, /ooxml or /iwork:
pnpm add @thomasfosterau/effect-parse
```

`effect` (`^4.0.0`) is a peer dependency; `@thomasfosterau/effect-parse` (`^0.5.0`) is an optional peer, needed only by the formats written on it.

## Example

```ts
import * as Effect from "effect/Effect";
import { contentToText, convert, text } from "@thomasfosterau/effect-document";
import * as Csv from "@thomasfosterau/effect-document/csv";
import { Xlsx } from "@thomasfosterau/effect-document/ooxml";

const roundTrip = Effect.gen(function* () {
  const { content: workbook } = yield* convert({
    from: Csv.format,
    to: Xlsx.format,
    input: text("product,price\nLaptop,999.99\n"),
  });
  const { content, loss } = yield* convert({ from: Xlsx.format, to: Csv.format, input: workbook });
  return { csv: contentToText(content), lossless: loss.isLossless };
});
```

## Entry points

No format is on the root entry, so importing it loads none of them.

| Entry | What it is |
| --- | --- |
| `.` (also `/schema`, `/profile`, `/profiles`, `/io`) | The document schema, profiles with `widen` / `narrow` and loss reports, and the `Reader` / `Writer` / `Format` / `convert` pipeline |
| `/csv` | CSV and TSV |
| `/ooxml` (also `/ooxml/xlsx`, `/ooxml/docx`, `/ooxml/pptx`) | XLSX, DOCX and PPTX |
| `/rtf` | RTF |
| `/pdf` (also `/pdf/cos`) | PDF, on a self-contained PDF object layer |
| `/iwork` (also `/iwork/pages`, `/iwork/numbers`, `/iwork/keynote`, `/iwork/codec`) | Experimental, read-only Keynote, Pages and Numbers |
| `/encoding` | Text encoding detection and strict decoding |

## Guides

- [Documents, profiles and conversion](https://github.com/thomasfosterau/effect-document/blob/trunk/packages/core/docs/guide.md)
- [Formats and the feature support matrix](https://github.com/thomasfosterau/effect-document/blob/trunk/packages/core/docs/formats.md): [CSV](https://github.com/thomasfosterau/effect-document/blob/trunk/packages/core/docs/csv.md), [OOXML](https://github.com/thomasfosterau/effect-document/blob/trunk/packages/core/docs/ooxml.md), [RTF](https://github.com/thomasfosterau/effect-document/blob/trunk/packages/core/docs/rtf.md), [PDF](https://github.com/thomasfosterau/effect-document/blob/trunk/packages/core/docs/pdf.md), [iWork](https://github.com/thomasfosterau/effect-document/blob/trunk/packages/core/docs/iwork.md)
- [API reference](https://github.com/thomasfosterau/effect-document/blob/trunk/packages/core/docs/api.md) and [performance](https://github.com/thomasfosterau/effect-document/blob/trunk/packages/core/docs/performance.md)

## License

MIT
