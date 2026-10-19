# @thomasfosterau/effect-document-csv

CSV/TSV reader and writer for [effect-document](https://github.com/thomasfosterau/effect-document): dialects, quoting, comments, type inference, streaming, and synthetic data.

```ts
import { text } from "@thomasfosterau/effect-document";
import * as Csv from "@thomasfosterau/effect-document-csv";

const doc = yield* Csv.makeCsvReader().read(text("name,age\nalice,30\n"));
```

See the [repository README](https://github.com/thomasfosterau/effect-document#readme) for the schema, profiles and conversion model.
