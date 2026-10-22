# @thomasfosterau/effect-rtf (packages/rtf)

RTF for its own `Rtf` profile (`profile.ts`): an effect-parse lexer plus a small interpreter (`reader.ts`) and a writer (`writer.ts`).

## Boundary

Peers: `effect`; dependencies `@thomasfosterau/effect-document` and `@thomasfosterau/effect-parse`. `.fallowrc.json` zone `rtf` may import `core` only.

## Invariants

- **The lexer is total**: every input lexes, so the reader fails only on content it cannot decode, never on RTF syntax.
- **Formatting is tracked per group** (`{ … }` pushes and pops the bold / italic / underline / strike state) and turned into nested `Strong` / `Emph` / `Underline` / `Strikeout` around `Str` runs.
- **Destinations it does not model are skipped wholesale** (font and colour tables, stylesheets, info, pictures, headers and footers, list tables, and every `\*` destination); add a name to `DESTINATIONS` rather than special-casing it in the interpreter.
- **`\uN` is followed by one ANSI fallback character, which is skipped**; negative `N` is a signed 16-bit code point.
- **The writer has no semantic headings**: a `Header` is a bold, larger paragraph, and reads back as a `Para`.
