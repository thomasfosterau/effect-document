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
 * `registry.ts`). Every declared length is checked against the buffer.
 */

import { Result } from "effect";
import { codecError, type IworkError, shiftOffset, toIworkError, withLocation } from "./errors.ts";
import { type DechunkOptions, dechunk } from "./iwa.ts";
import { type Field, getAllBytes, getBigInt, getVarint, parseMessage, readVarint } from "./protobuf.ts";

export interface IworkMessage {
  /** The reverse-engineered `MessageInfo.type` id. */
  readonly type: number;
  /** The raw payload bytes for this message. */
  readonly payload: Uint8Array;
}

export interface IworkObject {
  /** The object's document-unique identifier (a `uint64`, kept exact). */
  readonly identifier: bigint;
  readonly messages: ReadonlyArray<IworkMessage>;
}

/** Parse a message that is a view into `data`, with errors positioned in `data`. */
const parseIn = (data: Uint8Array, message: Uint8Array): Field[] => {
  try {
    return parseMessage(message);
  } catch (e) {
    throw shiftOffset(toIworkError(e), message.byteOffset - data.byteOffset);
  }
};

/**
 * Decode a decompressed object stream into its archived objects. Throws a
 * positioned `IworkError` on a truncated record or payload, or on an
 * `ArchiveInfo`/`MessageInfo` missing its identifier, type or length.
 */
export const decodeArchiveStream = (data: Uint8Array): IworkObject[] => {
  const objects: IworkObject[] = [];
  let pos = 0;
  while (pos < data.length) {
    const recordAt = pos;
    const lenRes = readVarint(data, pos);
    if (lenRes.value > data.length - lenRes.pos) {
      throw codecError(
        "Truncated",
        `ArchiveInfo needs ${lenRes.value} bytes, only ${data.length - lenRes.pos} left`,
        lenRes.pos
      );
    }
    const archiveInfo = parseIn(data, data.subarray(lenRes.pos, lenRes.pos + lenRes.value));
    pos = lenRes.pos + lenRes.value;

    const identifier = getBigInt(archiveInfo, 1);
    if (identifier === undefined) throw codecError("Malformed", "ArchiveInfo has no identifier", recordAt);
    const messages: IworkMessage[] = [];
    for (const miBytes of getAllBytes(archiveInfo, 2)) {
      const mi = parseIn(data, miBytes);
      const type = getVarint(mi, 1);
      const length = getVarint(mi, 3);
      if (type === undefined || length === undefined) {
        const missing = type === undefined ? "type" : "length";
        throw withLocation(codecError("Malformed", `MessageInfo has no ${missing}`, recordAt), {
          objectId: identifier,
        });
      }
      if (length > data.length - pos) {
        throw withLocation(
          codecError("Truncated", `payload needs ${length} bytes, only ${data.length - pos} left`, pos),
          { objectId: identifier }
        );
      }
      messages.push({ type, payload: data.subarray(pos, pos + length) });
      pos += length;
    }
    objects.push({ identifier, messages });
  }
  return objects;
};

/** Decode an `.iwa` file (dechunk + parse the object stream). */
export const decodeIwa = (
  iwaBytes: Uint8Array,
  options?: DechunkOptions
): Result.Result<IworkObject[], IworkError> => {
  try {
    return Result.succeed(decodeArchiveStream(dechunk(iwaBytes, options)));
  } catch (e) {
    return Result.fail(toIworkError(e));
  }
};
