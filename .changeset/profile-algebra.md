---
"@thomasfosterau/effect-document": minor
---

The profile algebra (#126): `unionProfiles`, `intersectProfiles`, `withoutFeatures` and `extendProfile` build profiles from profiles. Each is typed at the type level and at run time, and structural rules combine as the operation implies. `isSubProfile(a, b)` and the type `IsSubProfile<A, B>` ask whether one profile's documents all fit another, and `profileOf(doc)` gives the smallest profile a document fits.
