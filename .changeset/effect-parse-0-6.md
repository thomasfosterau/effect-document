---
"@thomasfosterau/effect-document": minor
---

The optional `@thomasfosterau/effect-parse` peer is now `^0.6.1` (was `^0.5.0`). **Breaking** for apps on effect-parse 0.5: upgrade it to 0.6. A streamed CSV row longer than effect-parse's 64 MiB stream buffer now fails with a `ParseError` whose `code` is `"LimitExceeded"`.
