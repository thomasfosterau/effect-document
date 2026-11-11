/**
 * Binary resources (#113): the media bag a document carries beside its blocks
 * (images, fonts, embedded files), after Pandoc's `MediaBag`. A node refers to
 * one by a `resource:<id>` URL in the string it already has (`Image.target.url`,
 * `Picture.src`), so external URLs keep working and no node changes shape.
 */

import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/** One binary resource: its bytes, their media type and, when the source named it, a file name. */
export class Resource extends Schema.Class<Resource>("Resource")({
  /** The IANA media type of `bytes` (`image/png`, `font/ttf`, `application/octet-stream`). */
  mediaType: Schema.String,
  /** The resource's content. Encoded to JSON as base64. */
  bytes: Schema.Uint8ArrayFromBase64,
  /** The name the source gave it (a DOCX `word/media/image1.png`, an EPUB manifest href), if any. */
  filename: Schema.optional(Schema.String),
}) {}

/** The plain-JSON encoded form of a {@link Resource}: its bytes as a base64 string. */
export type ResourceEncoded = Schema.Codec.Encoded<typeof Resource>;

/** A document's media bag: resources by id, the id being what follows `resource:` in a URL. */
export const Resources = Schema.Record(Schema.String, Resource);
/** A document's media bag, as a type. */
export type Resources = Schema.Schema.Type<typeof Resources>;

/** The URL scheme of a reference to a resource in the document's own media bag. */
export const RESOURCE_SCHEME = "resource:";

/** The URL a node uses to refer to the resource `id` (`resource:<id>`). */
export const resourceUrl = (id: string): string => `${RESOURCE_SCHEME}${id}`;

/** The resource id a URL refers to, or `None` for any other URL (an external link, a data URI). */
export const resourceIdOf = (url: string): Option.Option<string> =>
  url.startsWith(RESOURCE_SCHEME) && url.length > RESOURCE_SCHEME.length
    ? Option.some(url.slice(RESOURCE_SCHEME.length))
    : Option.none();

/** Whether two byte arrays hold the same bytes. */
const sameBytes = (a: Uint8Array, b: Uint8Array): boolean =>
  a.length === b.length && a.every((v, i) => v === b[i]);

/** Whether two resources are the same content of the same media type (their file names aside). */
export const sameResource = (a: Resource, b: Resource): boolean =>
  a.mediaType === b.mediaType && sameBytes(a.bytes, b.bytes);

/** An unsigned 32-bit value as eight hex digits. */
const hex32 = (n: number): string => (n >>> 0).toString(16).padStart(8, "0");

/**
 * An id derived from a resource's content: two 32-bit hashes (FNV-1a and
 * a multiplicative one) of its bytes, with its length, as hex. Equal contents
 * get equal ids, so a writer or reader that adds resources through
 * {@link addResource} stores each content once. Distinct contents can, very
 * rarely, share one: `addResource` compares the bytes and suffixes the id then.
 */
export const contentId = (bytes: Uint8Array): string => {
  // two folds of one number each, so no accumulator is allocated per byte
  const fnv = bytes.reduce((h, byte) => Math.imul(h ^ byte, 0x01000193), 0x811c9dc5);
  const mul = bytes.reduce((h, byte) => (Math.imul(h, 31) + byte) | 0, 0);
  return `${hex32(fnv)}${hex32(mul)}-${bytes.length.toString(16)}`;
};

/** A media bag with a resource added, and the id it is under. */
export interface AddedResource {
  /** The media bag holding the resource. */
  readonly resources: Resources;
  /** The resource's id: an existing one when the bag already held the same content. */
  readonly id: string;
}

/**
 * Add `resource` to `resources` under its {@link contentId}, deduplicating
 * by content (#113): when the bag already holds the same bytes of the same
 * media type, it is returned unchanged with that resource's id. The input is
 * not modified.
 */
export const addResource = (resources: Resources, resource: Resource): AddedResource =>
  addUnder(resources, resource, contentId(resource.bytes), 0);

/** {@link addResource} from the `n`th candidate id: `base`, then `base-1`, `base-2`, … past each collision. */
const addUnder = (
  resources: Resources,
  resource: Resource,
  base: string,
  n: number,
): AddedResource => {
  const id = n === 0 ? base : `${base}-${n}`;
  const existing = resources[id];
  if (existing === undefined) return { resources: { ...resources, [id]: resource }, id };
  return sameResource(existing, resource)
    ? { resources, id }
    : addUnder(resources, resource, base, n + 1);
};
