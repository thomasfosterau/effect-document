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

import { type Input, Parser } from "@thomasfosterau/effect-parse";
import { codecError, type IworkError } from "./errors.ts";

export const WIRE_VARINT = 0;
export const WIRE_I64 = 1;
export const WIRE_LEN = 2;
export const WIRE_I32 = 5;

export interface Field {
  readonly field: number;
  readonly wire: number;
  /**
   * Present for varint (0), i64 (1) and i32 (5) fields: the unsigned value as a
   * `number`, exact up to 2^53. Use {@link getBigInt}, {@link getDouble},
   * {@link getFloat} or {@link getSint} to read it as its declared type.
   */
  readonly value?: number | undefined;
  /** Present for a varint above 2^53: its exact (64-bit) value. */
  readonly big?: bigint | undefined;
  /** Present for i64 (1) and i32 (5) fields: the raw little-endian bytes. */
  readonly raw?: Uint8Array | undefined;
  /** Present for length-delimited (2) fields. */
  readonly bytes?: Uint8Array | undefined;
}

// ============================================================================
// Parsers
// ============================================================================

// The wire format is read by plain functions over a cursor, wrapped as
// effect-parse parsers (`varint`, `field`, `message`) for use in grammars.
// `parseMessage` and `readVarint` call the functions directly and turn a
// problem into an `IworkError`: iWork reads tens of thousands of tiny
// messages, and a parser run costs a few hundred ns each.

/** A read position in a byte buffer (an effect-parse `State` is one). */
interface Cursor {
  readonly input: Uint8Array;
  pos: number;
  readonly end: number;
}

/** Why a read failed; the cursor is left where the problem is. */
type Problem =
  | { readonly _tag: "Truncated"; readonly what: string; readonly size: number; readonly at: number }
  | { readonly _tag: "VarintTooLong"; readonly at: number }
  | { readonly _tag: "VarintTruncated"; readonly at: number }
  | { readonly _tag: "UnsupportedWire"; readonly wire: number; readonly field: number; readonly at: number };

/** Read a varint at the cursor, or the problem with it. */
const varintAt = (c: Cursor): number | Problem => {
  const start = c.pos;
  let value = 0;
  let shift = 0;
  for (;;) {
    if (c.pos >= c.end) return { _tag: "VarintTruncated", at: start };
    const b = c.input[c.pos++]!;
    value += (b & 0x7f) * 2 ** shift;
    if ((b & 0x80) === 0) return value;
    shift += 7;
    if (shift > 63) return { _tag: "VarintTooLong", at: start };
  }
};

/** The exact value of the varint in `input[start, end)` (for values above 2^53). */
const bigVarint = (input: Uint8Array, start: number, end: number): bigint => {
  let value = 0n;
  for (let i = end - 1; i >= start; i--) value = (value << 7n) | BigInt(input[i]! & 0x7f);
  return BigInt.asUintN(64, value);
};

/** Read a little-endian unsigned integer of `size` bytes at the cursor. */
const fixedAt = (c: Cursor, size: number): number => {
  let value = 0;
  for (let i = 0; i < size; i++) value += c.input[c.pos + i]! * 2 ** (8 * i);
  c.pos += size;
  return value;
};

/** Read one field at the cursor, or the problem with it. */
const fieldAt = (c: Cursor): Field | Problem => {
  const start = c.pos;
  const tag = varintAt(c);
  if (typeof tag !== "number") return tag;
  const field = Math.floor(tag / 8);
  const wire = tag & 7;
  const valueStart = c.pos;
  switch (wire) {
    case WIRE_VARINT: {
      const value = varintAt(c);
      if (typeof value !== "number") return value;
      return value > Number.MAX_SAFE_INTEGER
        ? { field, wire, value, big: bigVarint(c.input, valueStart, c.pos) }
        : { field, wire, value };
    }
    case WIRE_I64:
    case WIRE_I32: {
      const size = wire === WIRE_I64 ? 8 : 4;
      if (c.end - c.pos < size) return { _tag: "Truncated", what: "fixed-width field", size, at: valueStart };
      const raw = c.input.subarray(c.pos, c.pos + size);
      return { field, wire, value: fixedAt(c, size), raw };
    }
    case WIRE_LEN: {
      const length = varintAt(c);
      if (typeof length !== "number") return length;
      if (c.end - c.pos < length) {
        return { _tag: "Truncated", what: "length-delimited field", size: length, at: c.pos };
      }
      const bytes = c.input.subarray(c.pos, c.pos + length);
      c.pos += length;
      return { field, wire, bytes };
    }
    default:
      return { _tag: "UnsupportedWire", wire, field, at: start };
  }
};

const isProblem = (r: Field | Problem): r is Problem => "_tag" in r;

/** Report a problem as an effect-parse failure (always a cut: the input is malformed). */
const fail = (state: Input.State<Uint8Array>, p: Problem): Input.Fail => {
  switch (p._tag) {
    case "VarintTruncated":
      return state.cut("Take", ["varint byte"], state.end);
    case "VarintTooLong":
      return state.failMessage("Cut", "Verify", "varint longer than 10 bytes", p.at);
    case "Truncated":
      return state.failMessage(
        "Cut", "Take", `${p.what} needs ${p.size} bytes, only ${state.end - p.at} left`, p.at
      );
    case "UnsupportedWire":
      return state.failMessage("Cut", "Verify", `unsupported wire type ${p.wire} (field ${p.field})`, p.at);
  }
};

/** A base-128 varint, as a `number` (exact up to 2^53), of at most 10 bytes. */
export const varint: Parser.Parser<number, never, never, Uint8Array> = Parser.make<
  number, never, never, Uint8Array
>((state) => {
  const start = state.pos;
  if (start >= state.end) return state.eoi("Token", ["varint"], 1);
  const value = varintAt(state);
  return typeof value === "number" ? value : fail(state, value);
}, "varint");

/**
 * One field: its tag (field number and wire type) and value. A truncated
 * value or an unsupported wire type is a positioned error.
 */
export const field: Parser.Parser<Field, never, never, Uint8Array> = Parser.make<
  Field, never, never, Uint8Array
>((state) => {
  if (state.pos >= state.end) return state.eoi("Token", ["field"], 1);
  const result = fieldAt(state);
  return isProblem(result) ? fail(state, result) : result;
}, "protobuf field");

/** A whole message: fields until the end of the input. */
export const message: Parser.Parser<Field[], never, never, Uint8Array> = Parser.repeat(field);

/** A problem as an `IworkError`, positioned in the buffer being read. */
const problemError = (p: Problem, end: number): IworkError => {
  switch (p._tag) {
    case "VarintTruncated":
      return codecError("Truncated", "protobuf: truncated varint", p.at);
    case "VarintTooLong":
      return codecError("Malformed", "protobuf: varint longer than 10 bytes", p.at);
    case "Truncated":
      return codecError("Truncated", `protobuf: ${p.what} needs ${p.size} bytes, only ${end - p.at} left`, p.at);
    case "UnsupportedWire":
      return codecError("Malformed", `protobuf: unsupported wire type ${p.wire} (field ${p.field})`, p.at);
  }
};

/**
 * Read a base-128 varint at `pos`, returning the value and the new position.
 * Throws a positioned `IworkError` if it is truncated or too long.
 */
export const readVarint = (buf: Uint8Array, pos: number): { value: number; pos: number } => {
  const cursor: Cursor = { input: buf, pos, end: buf.length };
  const value = varintAt(cursor);
  if (typeof value === "number") return { value, pos: cursor.pos };
  throw problemError(value, buf.length);
};

/**
 * Parse a message into an ordered list of field records. Throws a positioned
 * `IworkError` on a truncated field or an unsupported wire type.
 */
export const parseMessage = (buf: Uint8Array): Field[] => {
  const cursor: Cursor = { input: buf, pos: 0, end: buf.length };
  const fields: Field[] = [];
  while (cursor.pos < cursor.end) {
    const result = fieldAt(cursor);
    if (isProblem(result)) throw problemError(result, buf.length);
    fields.push(result);
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

/** The first field number's scalar (varint or fixed-width), optionally of one wire type. */
const firstScalar = (fields: ReadonlyArray<Field>, field: number, wire?: number): Field | undefined =>
  fields.find((f) => f.field === field && f.value !== undefined && (wire === undefined || f.wire === wire));

const viewOf = (bytes: Uint8Array): DataView => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

/** A scalar field's value as an unsigned 64-bit integer. */
const toUint64 = (f: Field): bigint =>
  f.big ?? (f.wire === WIRE_I64 ? viewOf(f.raw!).getBigUint64(0, true) : BigInt(f.value!));

/** Zigzag-decode (`sint32`/`sint64`) an unsigned value. */
const unzigzag = (u: bigint): bigint => (u >> 1n) ^ -(u & 1n);

/** Zigzag-decode a value below 2^53. */
const unzigzagNumber = (v: number): number => (v % 2 === 0 ? v / 2 : -(v + 1) / 2);

/**
 * The first integer for a field number as an exact `bigint`: `uint64` (the
 * default), `int64` (two's complement) or `sint64` (zigzag). Reads varint and
 * fixed-width fields alike, so it covers `fixed64` and `sfixed64` too.
 */
export const getBigInt = (
  fields: ReadonlyArray<Field>,
  field: number,
  type: "uint64" | "int64" | "sint64" = "uint64"
): bigint | undefined => {
  const f = firstScalar(fields, field);
  if (f === undefined) return undefined;
  const u = toUint64(f);
  return type === "int64" ? BigInt.asIntN(64, u) : type === "sint64" ? unzigzag(u) : u;
};

/** The first zigzag (`sint32`/`sint64`) varint for a field number. */
export const getSint = (fields: ReadonlyArray<Field>, field: number): number | undefined => {
  const f = firstScalar(fields, field, WIRE_VARINT);
  if (f === undefined) return undefined;
  return f.big !== undefined ? Number(unzigzag(f.big)) : unzigzagNumber(f.value!);
};

/** The first `double` (64-bit) for a field number. */
export const getDouble = (fields: ReadonlyArray<Field>, field: number): number | undefined => {
  const f = firstScalar(fields, field, WIRE_I64);
  return f === undefined ? undefined : viewOf(f.raw!).getFloat64(0, true);
};

/** The first `float` (32-bit) for a field number. */
export const getFloat = (fields: ReadonlyArray<Field>, field: number): number | undefined => {
  const f = firstScalar(fields, field, WIRE_I32);
  return f === undefined ? undefined : viewOf(f.raw!).getFloat32(0, true);
};

/** How the elements of a repeated scalar field are encoded. */
export type PackedType = "varint" | "sint" | "fixed32" | "fixed64" | "float" | "double";

const PACKED_SIZE: Record<PackedType, number> = {
  varint: 0, sint: 0, fixed32: 4, float: 4, fixed64: 8, double: 8,
};

/** Read one fixed-width element of a packed run (or a single fixed field's raw bytes). */
const fixedElement = (view: DataView, at: number, type: PackedType): number => {
  switch (type) {
    case "double":
      return view.getFloat64(at, true);
    case "float":
      return view.getFloat32(at, true);
    case "fixed32":
      return view.getUint32(at, true);
    default:
      return view.getUint32(at, true) + view.getUint32(at + 4, true) * 2 ** 32;
  }
};

/**
 * All values of a repeated scalar field, whether packed (length-delimited
 * runs) or not (one field per value): parsers must accept both. `fixed64` and
 * varints are exact up to 2^53. Throws a positioned `IworkError` on a
 * malformed packed run.
 */
export const getPacked = (fields: ReadonlyArray<Field>, field: number, type: PackedType): number[] => {
  const size = PACKED_SIZE[type];
  const wire = size === 0 ? WIRE_VARINT : size === 8 ? WIRE_I64 : WIRE_I32;
  const out: number[] = [];
  for (const f of fields) {
    if (f.field !== field) continue;
    if (f.bytes !== undefined) {
      const bytes = f.bytes;
      if (size === 0) {
        const c: Cursor = { input: bytes, pos: 0, end: bytes.length };
        while (c.pos < c.end) {
          const v = varintAt(c);
          if (typeof v !== "number") throw problemError(v, bytes.length);
          out.push(type === "sint" ? unzigzagNumber(v) : v);
        }
      } else {
        if (bytes.length % size !== 0) {
          throw codecError("Malformed", `protobuf: packed ${type} run of ${bytes.length} bytes`, 0);
        }
        const view = viewOf(bytes);
        for (let at = 0; at < bytes.length; at += size) out.push(fixedElement(view, at, type));
      }
    } else if (f.wire === wire) {
      out.push(
        size !== 0 ? fixedElement(viewOf(f.raw!), 0, type)
          : type === "sint" ? unzigzagNumber(f.value!)
          : f.value!
      );
    }
  }
  return out;
};

const decoder = new TextDecoder();

/** Decode a length-delimited payload as a UTF-8 string. */
export const decodeUtf8 = (bytes: Uint8Array): string => decoder.decode(bytes);
