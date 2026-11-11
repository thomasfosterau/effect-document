---
"@thomasfosterau/effect-document": patch
---

fix(csv): `synthesizeTable` / `synthesizeDocument` with `seed: 0` no longer produce fields that are all `a`, and a negative seed no longer produces empty fields (#92). Any number is now a valid seed, and seeds that already worked give the same tables as before.
