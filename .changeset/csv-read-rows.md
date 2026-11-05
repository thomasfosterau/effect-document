---
"@thomasfosterau/effect-csv": minor
---

Add `readCsvRows`, which reads CSV text into rows of plain typed values (strings, numbers, booleans and `null`) with the same header handling and type inference as the reader, without building a document, and the `CsvValue` and `CsvRows` types. Long decimals (16 digits and more) are now classified and read from their digits without the regular expression, which makes reading full-precision floats several times faster for both `read` and `readCsvRows`. A quoted field with doubled wrappers is now unquoted, and a field is quoted on write, by joining the slices between its wrappers rather than with `replaceAll` (and a quoted field with no wrapper in it is not searched again), which makes reading and writing quoted CSV about a third faster.
