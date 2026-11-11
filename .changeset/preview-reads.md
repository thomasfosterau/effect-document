---
"@thomasfosterau/effect-document": minor
---

Preview reads (#188). The CSV and XLSX readers take `maxRows`. CSV reads at most that many records after `skipRows` (a header row counts as one) and never parses the rest of the input; XLSX keeps at most that many rows of each sheet. A document cut short carries `meta.truncated` (`{ maxRows, sheets }`), which `isTruncated` and `truncationOf` read, so a preview never passes for the whole file.
