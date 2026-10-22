# @thomasfosterau/effect-iwork

**Experimental**, read-only Apple iWork readers for [effect-document](https://github.com/thomasfosterau/effect-document): Keynote (slide text), Pages (body text, best-effort) and Numbers (sheet structure), plus a dependency-free container codec (IWA framing, Snappy, Protobuf wire reader, bundle opener).

```ts
import { Codec, Keynote, Numbers, Pages } from "@thomasfosterau/effect-iwork";
// or one app at a time
import * as Keynote from "@thomasfosterau/effect-iwork/keynote";
```

Malformed input fails with a typed, positioned `Codec.IworkError` (`NotZip`, `Encrypted`, `LimitExceeded`, `Truncated`, `Malformed`, `Io`) that names the component, object and byte offset; the readers wrap it in a `ParseError`. Only `Index/*.iwa` components are inflated, under entry-count and size limits (`limits`), and media is read on demand with `bundle.readEntry`. Pass `{ lenient: true }` to a reader to skip a component that fails to decode, with a logged warning. `Codec.openBundleDirectory` opens a package saved as a directory through the `FileSystem` service.

Test fixtures are vendored from MIT-licensed projects; see `test/fixtures/ATTRIBUTION.md`.

See the [repository README](https://github.com/thomasfosterau/effect-document#readme) for the schema, profiles and conversion model.
