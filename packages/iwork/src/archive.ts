/**
 * The archived-object stream inside a decompressed `.iwa`.
 *
 * The stream is a sequence of records, each: a varint length, a `TSP.ArchiveInfo`
 * message (object identifier + one or more `TSP.MessageInfo`s giving each
 * payload's type id and byte length), then the payload messages back-to-back.
 *
 * We decode each object as `{ identifier, messages: [{ type, payload }] }` and
 * leave the payloads as raw bytes for callers to interpret with the generic
 * Protobuf reader (the type→message mapping is reverse-engineered, see
 * `registry.ts`).
 */

import { dechunk } from "./iwa.js";
import { getAllBytes, getVarint, parseMessage, readVarint } from "./protobuf.js";

export interface IworkMessage {
  /** The reverse-engineered `MessageInfo.type` id. */
  readonly type: number;
  /** The raw payload bytes for this message. */
  readonly payload: Uint8Array;
}

export interface IworkObject {
  /** The object's document-unique identifier. */
  readonly identifier: number;
  readonly messages: ReadonlyArray<IworkMessage>;
}

/** Decode a decompressed object stream into its archived objects. */
export const decodeArchiveStream = (data: Uint8Array): IworkObject[] => {
  const objects: IworkObject[] = [];
  let pos = 0;
  while (pos < data.length) {
    const lenRes = readVarint(data, pos);
    const archiveInfo = parseMessage(data.subarray(lenRes.pos, lenRes.pos + lenRes.value));
    pos = lenRes.pos + lenRes.value;

    const identifier = getVarint(archiveInfo, 1) ?? 0;
    const messages: IworkMessage[] = [];
    for (const miBytes of getAllBytes(archiveInfo, 2)) {
      const mi = parseMessage(miBytes);
      const type = getVarint(mi, 1) ?? 0;
      const length = getVarint(mi, 3) ?? 0;
      messages.push({ type, payload: data.subarray(pos, pos + length) });
      pos += length;
    }
    objects.push({ identifier, messages });
  }
  return objects;
};

/** Decode an `.iwa` file (dechunk + parse the object stream). */
export const decodeIwa = (iwaBytes: Uint8Array): IworkObject[] =>
  decodeArchiveStream(dechunk(iwaBytes));
