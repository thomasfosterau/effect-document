/**
 * Extracting paragraphs from a `TSWP.StorageArchive` payload.
 *
 * A storage's `text` (field 3) is the body content with paragraphs separated by
 * newlines within a single string. We split on newlines, drop the object-
 * replacement character (U+FFFC, an inline-attachment placeholder), and skip
 * speaker-note storages by default. Character/paragraph styling is not yet read.
 */

import { decodeUtf8, getAllBytes, getVarint, parseMessage } from "./protobuf.ts";
import { STORAGE_KIND_FIELD, STORAGE_KIND_NOTE, STORAGE_TEXT_FIELD } from "./registry.ts";

const OBJECT_REPLACEMENT = /￼/g;

/** Split a `StorageArchive` payload into its text paragraphs (non-empty lines). */
export const storageParagraphs = (
  payload: Uint8Array,
  options?: { readonly includeNotes?: boolean }
): string[] => {
  const fields = parseMessage(payload);
  const kind = getVarint(fields, STORAGE_KIND_FIELD);
  if (options?.includeNotes !== true && kind === STORAGE_KIND_NOTE) return [];

  const out: string[] = [];
  for (const chunk of getAllBytes(fields, STORAGE_TEXT_FIELD)) {
    const text = decodeUtf8(chunk).replace(OBJECT_REPLACEMENT, "");
    for (const line of text.split("\n")) {
      if (line.trim() !== "") out.push(line);
    }
  }
  return out;
};
