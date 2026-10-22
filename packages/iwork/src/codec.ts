/**
 * The iWork (Pages/Numbers/Keynote) container codec - dependency-free.
 *
 * Layered bottom-up: a raw Snappy block codec, the IWA chunk framing, a generic
 * Protobuf wire reader, the archived-object stream, and the zip bundle opener.
 * Every layer fails with a typed, positioned `IworkError`. The per-app readers
 * build on these to extract text. Writing is not yet
 * supported (it requires the reverse-engineered object-graph schemas).
 *
 * EXPERIMENTAL: this reads a thin slice (text) of a proprietary, reverse-
 * engineered format; fidelity is partial and version-sensitive.
 */

export * from "./errors.ts";
export * from "./snappy.ts";
export * from "./protobuf.ts";
export * from "./iwa.ts";
export * from "./archive.ts";
export * from "./bundle.ts";
export * as Registry from "./registry.ts";
