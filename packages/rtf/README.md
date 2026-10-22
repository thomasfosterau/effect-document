# @thomasfosterau/effect-rtf

Rich Text Format for [`@thomasfosterau/effect-document`](https://www.npmjs.com/package/@thomasfosterau/effect-document): a reader and writer for the `Rtf` profile, paragraphs and headings with bold, italic, underline and strikeout runs. Destinations the reader does not model (font and colour tables, stylesheets, pictures, headers and footers, `\*` destinations) are skipped; `\uN` escapes and their ANSI fallbacks are handled.

> **Experimental.** The API is in flux; expect breaking changes before 1.0.

## Install

```sh
pnpm add effect @thomasfosterau/effect-document @thomasfosterau/effect-rtf
```

## Usage

```ts
import * as Effect from "effect/Effect";
import { blocksToText, contentToText, text } from "@thomasfosterau/effect-document";
import * as Rtf from "@thomasfosterau/effect-rtf";

const program = Effect.gen(function* () {
  const doc = yield* Rtf.makeRtfReader().read(text("{\\rtf1\\ansi Hello {\\b bold}\\par}"));
  blocksToText(doc.blocks); // "Hello bold"
  const out = yield* Rtf.makeRtfWriter().write(doc);
  return contentToText(out); // "{\\rtf1\\ansi\\deff0\\fs24\n\\pard Hello {\\b bold}\\par\n}"
});
```

Headings are written as bold, larger paragraphs (RTF has no semantic headings), so they read back as paragraphs. Use `Rtf.format` with `convert` to move between RTF and the other formats: DOCX → RTF reports the links, lists and tables it has to drop.

## API reference

### `@thomasfosterau/effect-rtf`

| Export | Kind | Description |
| --- | --- | --- |
| `profile` | const | The RTF profile. |
| `format` | const | The RTF format bundle, for use with `convert`. |
| `rtfFeatures` | const | The features the RTF profile allows, as a list. |
| `Rtf` | const | The RTF profile. |
| `RtfFeature` | type | The features the RTF profile allows, as a type. |
| `makeRtfReader` | function | Create an RTF Reader. |
| `RtfReaderTag` | const | The Context tag for the RTF reader, so a program can depend on an RTF reader and have one provided. |
| `RtfReaderLive` | const | A Layer providing the default RTF reader for `RtfReaderTag`. |
| `RtfWriterOptions` | interface | Options for the RTF writer. |
| `makeRtfWriter` | function | Create an RTF Writer. |
| `RtfWriterTag` | const | The Context tag for the RTF writer, so a program can depend on an RTF writer and have one provided. |
| `RtfWriterLive` | const | A Layer providing the default RTF writer for `RtfWriterTag`. |
