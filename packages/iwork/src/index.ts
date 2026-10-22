/**
 * effect-document: Apple iWork (read-only, experimental)
 *
 * Readers for Pages, Numbers and Keynote, plus the shared container codec they
 * build on. Each app is also available on its own subpath (`/pages`,
 * `/numbers`, `/keynote`), and the codec on `/codec`.
 */

export * as Pages from "./pages.ts";
export * as Numbers from "./numbers.ts";
export * as Keynote from "./keynote.ts";
export * as Codec from "./codec.ts";
