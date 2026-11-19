/**
 * `@thomasfosterau/effect-document/encoding`: text encoding detection and
 * decoding for import. Its own subpath because it is the package's one
 * use of `@thomasfosterau/effect-ext`, so the core entries stay
 * dependency-free.
 */

export * from "./detect.ts";
