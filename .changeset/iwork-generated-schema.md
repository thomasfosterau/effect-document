---
"@thomasfosterau/effect-document": patch
---

The iWork readers take their protobuf type ids and field numbers from a module generated from a vendored snapshot of keynote-parser's and numbers-parser's `.proto` files (`vpx packages/core/scripts/generate-iwork-schema.ts`), instead of hand-written constants. No change in behaviour.
