---
"@thomasfosterau/effect-document": minor
---

Loss reports say where and how badly (#112). Each `LossEntry` gains a `path` (block indexes from the document's top, then list item, slide, shape or table row indexes, a part such as `"notes"`, or a worksheet cell's A1 address) and a `severity` (`dropped-content`, `dropped-formatting` or `converted`). A `LossReport` gains a `summary` that groups its entries by feature and action, with a count and the first five paths. `LossEntry`, `LossReport` and their parts are now `Schema`s, so a report encodes to JSON. `convert` takes `onLoss: "allow" | "warn" | "fail"`: `"warn"` logs a warning per summary item, and `"fail"` fails with a `ConversionError` whose new `loss` field holds the report.
