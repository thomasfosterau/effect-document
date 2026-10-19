# @thomasfosterau/effect-iwork

**Experimental**, read-only Apple iWork readers for [effect-document](https://github.com/thomasfosterau/effect-document): Keynote (slide text), Pages (body text, best-effort) and Numbers (sheet structure), plus a dependency-free container codec (IWA framing, Snappy, Protobuf wire reader, bundle opener).

```ts
import { Codec, Keynote, Numbers, Pages } from "@thomasfosterau/effect-iwork";
// or one app at a time
import * as Keynote from "@thomasfosterau/effect-iwork/keynote";
```

Test fixtures are vendored from MIT-licensed projects; see `test/fixtures/ATTRIBUTION.md`.

See the [repository README](https://github.com/thomasfosterau/effect-document#readme) for the schema, profiles and conversion model.
