/**
 * The iWork (Pages/Numbers/Keynote) container codec - dependency-free.
 *
 * Layered bottom-up: a raw Snappy block codec, the IWA chunk framing, a generic
 * Protobuf wire reader, the archived-object stream, and the zip bundle opener.
 * The per-app readers build on these to extract text. Writing is not yet
 * supported (it requires the reverse-engineered object-graph schemas).
 *
 * EXPERIMENTAL: this reads a thin slice (text) of a proprietary, reverse-
 * engineered format; fidelity is partial and version-sensitive.
 */

export * from "./snappy.js";
export * from "./protobuf.js";
export * from "./iwa.js";
export * from "./archive.js";
export * from "./bundle.js";
export * as Registry from "./registry.js";
