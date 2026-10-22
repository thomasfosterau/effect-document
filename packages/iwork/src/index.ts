/**
 * effect-document: Apple iWork (read-only, experimental)
 *
 * Readers for Pages, Numbers and Keynote, plus the shared container codec they
 * build on. Each app is also available on its own subpath (`/pages`,
 * `/numbers`, `/keynote`), and the codec on `/codec`.
 */

/** The Pages reader (experimental): body text as paragraphs. */
export * as Pages from "./pages.ts";
/** The Numbers reader (experimental): sheet structure, without cell values. */
export * as Numbers from "./numbers.ts";
/** The Keynote reader (experimental): slide text. */
export * as Keynote from "./keynote.ts";
/** The iWork container codec: bundle opening, IWA chunk framing, Snappy, the protobuf wire reader and the archive decoder. */
export * as Codec from "./codec.ts";
