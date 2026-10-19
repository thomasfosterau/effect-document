/**
 * effect-document: Apple iWork (read-only, experimental)
 *
 * Readers for Pages, Numbers and Keynote, plus the shared container codec they
 * build on. Each app is also available on its own subpath (`/pages`,
 * `/numbers`, `/keynote`), and the codec on `/codec`.
 */

export * as Pages from "./pages.js";
export * as Numbers from "./numbers.js";
export * as Keynote from "./keynote.js";
export * as Codec from "./codec.js";
