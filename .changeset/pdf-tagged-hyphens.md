---
"@thomasfosterau/effect-pdf": patch
---

The PDF reader no longer joins a tagged line that ends in a plain hyphen to the next line's first word (#198). In Tagged PDF a hyphen added by line breaking is a soft hyphen (U+00AD), so only that one joins a word across lines; a `-` at a line end is part of the text. Untagged files keep the layout heuristic. The writer's own output now round-trips words that end in a hyphen.
