---
"@thomasfosterau/effect-document": patch
---

Build on `@thomasfosterau/effect-parse` 0.2 (was 0.1), whose `Parser.compile` is now `Compiler.jit`.

- `scanCsvStream` (and so the CSV reader's `readStream`) runs a compiled row grammar, memoized per dialect and options like the whole-text one: about twice as fast on a 4 MB file. Rows and errors are unchanged.
- The `a1AbsoluteCell` and `a1Range` parsers (`parseA1Absolute`, `parseA1Range`) are compiled too, like `a1Cell`.
