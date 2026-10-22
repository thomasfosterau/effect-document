# @thomasfosterau/effect-iwork

Read-only Apple iWork readers for [`@thomasfosterau/effect-document`](https://www.npmjs.com/package/@thomasfosterau/effect-document): Keynote (`.key`, slide text), Pages (`.pages`, body text) and Numbers (`.numbers`, sheet structure), plus the dependency-free container codec they are built on.

> **Experimental.** iWork files are reverse-engineered binary bundles, so these readers are best-effort and read _text_ only: Keynote yields each slide's text, Pages its body paragraphs, Numbers its sheets without cell values. Writing needs Apple's proprietary object-graph schemas and is not supported. Password-protected documents are detected and refused.

## Install

```sh
pnpm add effect @thomasfosterau/effect-document @thomasfosterau/effect-iwork
```

## Usage

```ts
import * as Effect from "effect/Effect";
import { blocksToText, bytes, convert } from "@thomasfosterau/effect-document";
import * as Keynote from "@thomasfosterau/effect-iwork/keynote";
import * as Rtf from "@thomasfosterau/effect-rtf";

declare const deck: Uint8Array; // the bytes of a .key file

const program = Effect.gen(function* () {
  const doc = yield* Keynote.makeKeynoteReader().read(bytes(deck));
  // or straight into a writable format; the loss report says what was flattened
  const { content, loss } = yield* convert({
    from: Keynote.format,
    to: Rtf.format,
    input: bytes(deck),
  });
  return { text: blocksToText(doc.blocks), content, loss };
});
```

Each app has its own subpath (`/keynote`, `/pages`, `/numbers`); the root exports all three as namespaces plus `Codec`.

Every reader takes `IworkReaderOptions`:

- `limits` (`BundleLimits`): the most zip entries, the largest entry and the most total bytes the bundle may inflate (defaults in `DEFAULT_BUNDLE_LIMITS`), so a zip bomb fails with `LimitExceeded` instead of exhausting memory. Only `Index/*.iwa` components are inflated; media is read on demand with `bundle.readEntry`.
- `lenient`: skip a component that fails to decode, with a logged warning (`Effect.logWarning`), instead of failing the whole read.

## Errors

Malformed input fails with the codec's `IworkError`, a `Schema.TaggedError` whose `reason` is one of `NotZip`, `NotIwork` (a zip without `.iwa` components, such as a `.docx`), `LegacyIwork09Unsupported`, `Encrypted`, `LimitExceeded`, `Truncated`, `Malformed` or `Io`, and which names the component, object and byte offset it happened at. The readers wrap it in a `ParseError` whose `reason` repeats that location and whose `cause` is the `IworkError`.

## The container codec

`@thomasfosterau/effect-iwork/codec` exposes the layers the readers use, for working with iWork files directly:

- `openBundle` opens the ZIP bundle and its `.iwa` components, including older documents' nested `Index.zip`; `openBundleDirectory` opens a package saved as a directory (a `.key` folder) through the `FileSystem` service.
- `dechunk` / `chunk` handle IWA chunk framing.
- `decompressBlock` / `compressBlock` are Apple's non-standard Snappy block format; the compressor writes literals only, which every Snappy decoder accepts.
- The protobuf wire reader: `parseMessage`, `readVarint` and the field accessors.
- `decodeArchiveStream` decodes archived objects and their messages.

`Registry` holds the few reverse-engineered message type ids the readers use; they come from the [keynote-parser](https://github.com/psobot/keynote-parser) v14.4 mapping and can drift between iWork versions.

Test fixtures are vendored from MIT-licensed projects; see `test/fixtures/ATTRIBUTION.md`.

## API reference

The root entry exports the namespaces `Pages`, `Numbers`, `Keynote` and `Codec`; each subpath exports one of them flat.

### `@thomasfosterau/effect-iwork/pages`

| Export | Kind | Description |
| --- | --- | --- |
| `IworkReaderOptions` | interface | Options shared by the Pages, Numbers and Keynote readers. |
| `pagesFeatures` | const | The features the Pages profile allows, as a list. |
| `Pages` | const | The Pages (read) profile. |
| `PagesFeature` | type | The features the Pages profile allows, as a type. |
| `makePagesReader` | function | Create a Pages Reader. |
| `profile` | const | The Pages profile (alias of `Pages`). |
| `format` | const | The Pages format bundle (read-only) for use with `convert`. |
| `PagesReaderTag` | const | The Context tag for the Pages reader, so a program can depend on a Pages reader and have one provided. |
| `PagesReaderLive` | const | A Layer providing the default Pages reader for `PagesReaderTag`. |

### `@thomasfosterau/effect-iwork/numbers`

| Export | Kind | Description |
| --- | --- | --- |
| `IworkReaderOptions` | interface | Options shared by the Pages, Numbers and Keynote readers. |
| `numbersFeatures` | const | The features the Numbers profile allows, as a list. |
| `Numbers` | const | The Numbers (read) profile. |
| `NumbersFeature` | type | The features the Numbers profile allows, as a type. |
| `makeNumbersReader` | function | Create a Numbers Reader (structure only - sheet names, no cell values yet). |
| `profile` | const | The Numbers profile (alias of `Numbers`). |
| `format` | const | The Numbers format bundle (read-only, structure only) for use with `convert`. |
| `NumbersReaderTag` | const | The Context tag for the Numbers reader, so a program can depend on a Numbers reader and have one provided. |
| `NumbersReaderLive` | const | A Layer providing the default Numbers reader for `NumbersReaderTag`. |

### `@thomasfosterau/effect-iwork/keynote`

| Export | Kind | Description |
| --- | --- | --- |
| `IworkReaderOptions` | interface | Options shared by the Pages, Numbers and Keynote readers. |
| `keynoteFeatures` | const | The features the Keynote profile allows, as a list. |
| `Keynote` | const | The Keynote (read) profile. |
| `KeynoteFeature` | type | The features the Keynote profile allows, as a type. |
| `makeKeynoteReader` | function | Create a Keynote Reader. |
| `profile` | const | The Keynote profile (alias of `Keynote`). |
| `format` | const | The Keynote format bundle (read-only) for use with `convert`. |
| `KeynoteReaderTag` | const | The Context tag for the Keynote reader, so a program can depend on a Keynote reader and have one provided. |
| `KeynoteReaderLive` | const | A Layer providing the default Keynote reader for `KeynoteReaderTag`. |

### `@thomasfosterau/effect-iwork/codec`

| Export | Kind | Description |
| --- | --- | --- |
| `codecError` | function | Fail at an offset (a shorthand for the codec's many checks). |
| `fromParseError` | function | Convert an effect-parse error (from a framing grammar) into an `IworkError`. |
| `IworkError` | class | The codec's one failure. |
| `IworkErrorReason` | const | Why the codec failed. |
| `isIworkError` | function | Whether a caught value is the codec's `IworkError`. |
| `shiftOffset` | function | Move an error's offset by `by` bytes (an inner buffer's position in its outer one). |
| `toIworkError` | function | Normalise a caught value. |
| `withLocation` | function | Fill in the component / object an error happened in, keeping any already set. |
| `Registry` | namespace | The handful of reverse-engineered iWork message type ids the readers use. |
| `DecompressOptions` | interface | Options for `decompressBlock`. |
| `DEFAULT_MAX_BLOCK_LENGTH` | const | The default `DecompressOptions.maxLength`. |
| `decompressBlock` | function | Decompress one raw Snappy block. |
| `compressBlock` | function | Compress to a valid raw Snappy block using only literal elements. |
| `WIRE_VARINT` | const | Protobuf wire type 0. |
| `WIRE_I64` | const | Protobuf wire type 1. |
| `WIRE_LEN` | const | Protobuf wire type 2. |
| `WIRE_I32` | const | Protobuf wire type 5. |
| `Field` | interface | One protobuf field record. |
| `varint` | const | A base-128 varint, as a `number` (exact up to 2^53), of at most 10 bytes. |
| `field` | const | One field. |
| `message` | const | A whole message. |
| `VarintRead` | interface | A varint read by `readVarint`. |
| `readVarint` | function | Read a base-128 varint at `pos`, returning the value and the new position. |
| `parseMessage` | function | Parse a message into an ordered list of field records. |
| `getVarint` | function | The first varint/fixed value for a field number, if present. |
| `getBytes` | function | The first length-delimited payload for a field number, if present. |
| `getAllBytes` | function | All length-delimited payloads for a field number (e.g. |
| `getAllVarints` | function | All varint/fixed values for a field number. |
| `getBigInt` | function | The first integer for a field number as an exact `bigint`. |
| `getSint` | function | The first zigzag (`sint32`/`sint64`) varint for a field number. |
| `getDouble` | function | The first `double` (64-bit) for a field number. |
| `getFloat` | function | The first `float` (32-bit) for a field number. |
| `PackedType` | type | How the elements of a repeated scalar field are encoded. |
| `getPacked` | function | All values of a repeated scalar field, whether packed (length-delimited runs) or not (one field per value). |
| `decodeUtf8` | function | Decode a length-delimited payload as a UTF-8 string. |
| `DechunkOptions` | interface | Options for `dechunk`. |
| `DEFAULT_MAX_STREAM_LENGTH` | const | The default `DechunkOptions.maxLength`. |
| `dechunk` | function | Decode an `.iwa` file into its concatenated, decompressed Protobuf stream. |
| `chunk` | function | Encode a Protobuf stream into IWA chunks (64 KiB uncompressed blocks). |
| `IworkMessage` | interface | One archived message. |
| `IworkObject` | interface | One archived object. |
| `decodeArchiveStream` | function | Decode a decompressed object stream into its archived objects. |
| `decodeIwa` | function | Decode an `.iwa` file (dechunk + parse the object stream). |
| `IworkBundle` | interface | An opened iWork document. |
| `BundleLimits` | interface | Zip-bomb limits for opening a bundle; any left out take the `DEFAULT_BUNDLE_LIMITS` value. |
| `OpenBundleOptions` | interface | Options for `openBundle` and `openBundleDirectory`. |
| `DEFAULT_BUNDLE_LIMITS` | const | The default `BundleLimits`. |
| `ResolvedLimits` | type | `BundleLimits` with every limit filled in. |
| `openBundle` | function | Open an iWork bundle, inflating only its `.iwa` components. |
| `openBundleDirectory` | function | Open an iWork package saved as a directory (e.g. |
| `compareComponentPaths` | function | Compare paths with their digit runs as numbers, so `Slide-8060.iwa` sorts before `Slide-10000.iwa` and `Slide-8060.iwa` before `Slide-8060-2.iwa`. |
| `ComponentPathOrder` | const | Component paths in natural order, as an `Order` (see `compareComponentPaths`). |
| `componentPaths` | function | The component paths matching a predicate (e.g. |
| `decodeComponent` | function | Decode a single component's archived objects (none if it is absent). |
| `decodeAll` | function | Decode every component's objects, flattened (a whole-document object scan). |
