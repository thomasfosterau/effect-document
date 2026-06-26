/**
 * A minimal, schema-free Protobuf wire reader/writer.
 *
 * iWork payloads are not self-describing, but the *wire* format is: every
 * field's length is determined by its wire type alone, so a generic field-walk
 * can traverse any message without a compiled `.proto`. We read each message
 * into an ordered list of {field, wire, ...} records; callers that know a field
 * number (from the reverse-engineered schemas) pull values out by hand.
 *
 * Only the wire types iWork uses are needed: varint (0), 64-bit (1),
 * length-delimited (2), 32-bit (5).
 */

export const WIRE_VARINT = 0;
export const WIRE_I64 = 1;
export const WIRE_LEN = 2;
export const WIRE_I32 = 5;

export interface Field {
  readonly field: number;
  readonly wire: number;
  /** Present for varint (0), i64 (1) and i32 (5) fields. */
  readonly value?: number;
  /** Present for length-delimited (2) fields. */
  readonly bytes?: Uint8Array;
}

/** Read a base-128 varint at `pos`, returning the value and the new position. */
export const readVarint = (buf: Uint8Array, pos: number): { value: number; pos: number } => {
  let value = 0;
  let shift = 0;
  let p = pos;
  for (;;) {
    if (p >= buf.length) throw new Error("protobuf: truncated varint");
    const b = buf[p++]!;
    value += (b & 0x7f) * 2 ** shift;
    if ((b & 0x80) === 0) break;
    shift += 7;
    if (shift > 63) throw new Error("protobuf: varint too long");
  }
  return { value, pos: p };
};

/** Parse a message into an ordered list of field records. */
export const parseMessage = (buf: Uint8Array): Field[] => {
  const fields: Field[] = [];
  let pos = 0;
  while (pos < buf.length) {
    const tag = readVarint(buf, pos);
    pos = tag.pos;
    const field = Math.floor(tag.value / 8);
    const wire = tag.value & 7;
    switch (wire) {
      case WIRE_VARINT: {
        const v = readVarint(buf, pos);
        pos = v.pos;
        fields.push({ field, wire, value: v.value });
        break;
      }
      case WIRE_I64: {
        let v = 0;
        for (let i = 0; i < 8; i++) v += buf[pos + i]! * 2 ** (8 * i);
        pos += 8;
        fields.push({ field, wire, value: v });
        break;
      }
      case WIRE_LEN: {
        const len = readVarint(buf, pos);
        pos = len.pos;
        const bytes = buf.subarray(pos, pos + len.value);
        pos += len.value;
        fields.push({ field, wire, bytes });
        break;
      }
      case WIRE_I32: {
        let v = 0;
        for (let i = 0; i < 4; i++) v += buf[pos + i]! * 2 ** (8 * i);
        pos += 4;
        fields.push({ field, wire, value: v });
        break;
      }
      default:
        throw new Error(`protobuf: unsupported wire type ${wire} (field ${field})`);
    }
  }
  return fields;
};

/** The first varint/fixed value for a field number, if present. */
export const getVarint = (fields: ReadonlyArray<Field>, field: number): number | undefined =>
  fields.find((f) => f.field === field && f.value !== undefined)?.value;

/** The first length-delimited payload for a field number, if present. */
export const getBytes = (fields: ReadonlyArray<Field>, field: number): Uint8Array | undefined =>
  fields.find((f) => f.field === field && f.bytes !== undefined)?.bytes;

/** All length-delimited payloads for a field number (e.g. repeated fields). */
export const getAllBytes = (fields: ReadonlyArray<Field>, field: number): Uint8Array[] =>
  fields.filter((f) => f.field === field && f.bytes !== undefined).map((f) => f.bytes!);

/** All varint/fixed values for a field number. */
export const getAllVarints = (fields: ReadonlyArray<Field>, field: number): number[] =>
  fields.filter((f) => f.field === field && f.value !== undefined).map((f) => f.value!);

const decoder = new TextDecoder();

/** Decode a length-delimited payload as a UTF-8 string. */
export const decodeUtf8 = (bytes: Uint8Array): string => decoder.decode(bytes);
