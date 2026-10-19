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
import { Result } from "effect";

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

// ============================================================================
// Parsers
// ============================================================================

// The wire format is read by plain functions over a cursor, wrapped as
// effect-parse parsers (`varint`, `field`, `message`) for use in grammars and
// for positioned errors. `parseMessage` and `readVarint` call the functions
// directly and only run the parsers to explain a failure: iWork reads tens of
// thousands of tiny messages, and a parser run costs a few hundred ns each.

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
  | { readonly _tag: "VarintTruncated" }
  | { readonly _tag: "UnsupportedWire"; readonly wire: number; readonly field: number; readonly at: number };

const varintTruncated: Problem = { _tag: "VarintTruncated" };

/** Read a varint at the cursor, or the problem with it. */
const varintAt = (c: Cursor): number | Problem => {
  const start = c.pos;
  let value = 0;
  let shift = 0;
  for (;;) {
    if (c.pos >= c.end) return varintTruncated;
    const b = c.input[c.pos++]!;
    value += (b & 0x7f) * 2 ** shift;
    if ((b & 0x80) === 0) return value;
    shift += 7;
    if (shift > 63) return { _tag: "VarintTooLong", at: start };
  }
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
      return typeof value === "number" ? { field, wire, value } : value;
    }
    case WIRE_I64:
    case WIRE_I32: {
      const size = wire === WIRE_I64 ? 8 : 4;
      if (c.end - c.pos < size) return { _tag: "Truncated", what: "fixed-width field", size, at: valueStart };
      return { field, wire, value: fixedAt(c, size) };
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

/**
 * Read a base-128 varint at `pos`, returning the value and the new position.
 * Throws a positioned `ParseError` if it is truncated or too long.
 */
export const readVarint = (buf: Uint8Array, pos: number): { value: number; pos: number } => {
  const cursor: Cursor = { input: buf, pos, end: buf.length };
  const value = varintAt(cursor);
  if (typeof value === "number") return { value, pos: cursor.pos };
  const result = Parser.parsePeek(varint, buf.subarray(pos));
  throw Result.isFailure(result) ? result.failure : new Error("protobuf: bad varint");
};

/**
 * Parse a message into an ordered list of field records. Throws a positioned
 * `ParseError` on a truncated field or an unsupported wire type.
 */
export const parseMessage = (buf: Uint8Array): Field[] => {
  const cursor: Cursor = { input: buf, pos: 0, end: buf.length };
  const fields: Field[] = [];
  while (cursor.pos < cursor.end) {
    const result = fieldAt(cursor);
    if (isProblem(result)) return Parser.parseSync(message, buf); // throws, with the position
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

const decoder = new TextDecoder();

/** Decode a length-delimited payload as a UTF-8 string. */
export const decodeUtf8 = (bytes: Uint8Array): string => decoder.decode(bytes);
