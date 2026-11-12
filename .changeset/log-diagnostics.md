---
"@thomasfosterau/effect-document": minor
---

Readers and writers report non-fatal issues as diagnostics (#112): annotated warning log records (`logDiagnostic`, `DIAGNOSTIC_ANNOTATION`) that `convert` collects into the new `LossReport.diagnostics`, and `collectDiagnostics` returns beside any effect's result. A diagnostic other than `repaired` makes the report lossy and fails `onLoss: "fail"`. The XLSX writer reports each `NaN` or `±Infinity` written as `#NUM!` (`xlsx.nonFiniteNumber`) and each sheet renamed to a name Excel accepts (`xlsx.sheetRenamed`); a lenient iWork read reports each component it skipped (`iwork.componentSkipped`). `lossReport` takes the diagnostics as an optional second argument.
