/**
 * Schema-free protobuf field records over Effect's `ProtobufReader`. iWork
 * payloads aren't self-describing, but every field's length follows from its
 * wire type, so a message reads into an ordered list of records that callers
 * pick apart by the field numbers in the reverse-engineered schemas.
 */

import * as Result from "effect/Result";
import { ProtobufReader } from "effect/protobuf";
import { type Input, Parser } from "@thomasfosterau/effect-parse";
import { codecError, type IworkError, rethrowing, shiftOffset, toIworkError } from "./errors.ts";

/** Protobuf wire type 0: a base-128 varint. */
export const WIRE_VARINT = ProtobufReader.WireType.Varint;
/** Protobuf wire type 1: a fixed 64-bit value. */
export const WIRE_I64 = ProtobufReader.WireType.I64;
/** Protobuf wire type 2: a length-delimited byte string. */
export const WIRE_LEN = ProtobufReader.WireType.Len;
/** Protobuf wire type 5: a fixed 32-bit value. */
export const WIRE_I32 = ProtobufReader.WireType.I32;

/** One protobuf field record: its number, wire type, and value (numeric types) or bytes (length-delimited). */
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
// Reading
// ============================================================================

/** Read one field. `input` is the reader's whole input, which `raw` and `big` are sliced from. */
const readField = (r: ProtobufReader.ProtobufReader, input: Uint8Array): Field => {
  const start = r.offset;
  const tag = r.tag();
  const field = ProtobufReader.fieldNumber(tag);
  const wire = ProtobufReader.wireType(tag);
  const at = r.offset;
  if (wire === WIRE_VARINT) {
    const value = r.uint64Number();
    return Number.isSafeInteger(value)
      ? { field, wire, value }
      : { field, wire, value, big: ProtobufReader.make(input.subarray(at, r.offset)).uint64() };
  }
  if (wire === WIRE_I64 || wire === WIRE_I32) {
    const value = wire === WIRE_I64 ? r.fixed64Number() : r.fixed32();
    return { field, wire, value, raw: input.subarray(at, r.offset) };
  }
  if (wire === WIRE_LEN) return { field, wire, bytes: r.bytesView() };
  // Group tags (wire types 3 and 4) are valid protobuf, but iWork never writes them.
  throw codecError("Malformed", `protobuf: unsupported wire type ${wire} (field ${field})`, start);
};

const isTruncation = (e: ProtobufReader.ProtobufReaderError): boolean =>
  e.message.startsWith("Expected a complete value");

/** The reader's message without its trailing offset, which the error carries already. */
const readerDetail = (e: ProtobufReader.ProtobufReaderError): string =>
  `protobuf: ${e.message.replace(/ at offset \d+$/, "")}`;

/** A read failure as an `IworkError`, its offset moved by `shift` (the reader's start in the caller's buffer). */
const readError =
  (shift: number) =>
  (cause: unknown): IworkError => {
    if (cause instanceof ProtobufReader.ProtobufReaderError)
      return codecError(
        isTruncation(cause) ? "Truncated" : "Malformed",
        readerDetail(cause),
        cause.offset + shift,
      );
    return shiftOffset(toIworkError(cause), shift);
  };

/** Run `read` over `state`'s remaining input as an effect-parse step (failures are cuts: the input is malformed). */
const parseStep = <A>(
  state: Input.State<Uint8Array>,
  read: (r: ProtobufReader.ProtobufReader, input: Uint8Array) => A,
): A | Input.Fail => {
  const input = state.input.subarray(state.pos, state.end);
  const r = ProtobufReader.make(input);
  const result = Result.try({ try: () => read(r, input), catch: readError(state.pos) });
  if (Result.isSuccess(result)) {
    state.pos += r.offset;
    return result.success;
  }
  const e = result.failure;
  return state.failMessage(
    "Cut",
    e.reason === "Truncated" ? "Take" : "Verify",
    e.detail,
    e.offset ?? state.pos,
  );
};

/** A base-128 varint, as a `number` (exact up to 2^53), of at most 10 bytes. */
export const varint: Parser.Parser<number, never, never, Uint8Array> = Parser.make<
  number,
  never,
  never,
  Uint8Array
>((state) => {
  if (state.pos >= state.end) return state.eoi("Token", ["varint"], 1);
  return parseStep(state, (r) => r.uint64Number());
}, "varint");

/**
 * One field: its tag (field number and wire type) and value. A truncated
 * value or an unsupported wire type is a positioned error.
 */
export const field: Parser.Parser<Field, never, never, Uint8Array> = Parser.make<
  Field,
  never,
  never,
  Uint8Array
>((state) => {
  if (state.pos >= state.end) return state.eoi("Token", ["field"], 1);
  return parseStep(state, readField);
}, "protobuf field");

/** A whole message: fields until the end of the input. */
export const message: Parser.Parser<Field[], never, never, Uint8Array> = Parser.repeat(field);

/** A varint read by {@link readVarint}: its value and the position after it. */
export interface VarintRead {
  readonly value: number;
  readonly pos: number;
}

/**
 * Read a base-128 varint at `pos`, returning the value and the new position.
 * Throws a positioned `IworkError` if it is truncated or too long.
 */
export const readVarint = (buf: Uint8Array, pos: number): VarintRead => {
  const r = ProtobufReader.make(buf.subarray(pos));
  const value = rethrowing(() => r.uint64Number(), readError(pos));
  return { value, pos: pos + r.offset };
};

/**
 * Parse a message into an ordered list of field records. Throws a positioned
 * `IworkError` on a truncated field or an unsupported wire type.
 */
export const parseMessage = (buf: Uint8Array): Field[] =>
  rethrowing(() => {
    const r = ProtobufReader.make(buf);
    const fields: Field[] = [];
    while (!r.isDone()) fields.push(readField(r, buf));
    return fields;
  }, readError(0));

/** The first varint/fixed value for a field number, if present. */
export const getVarint = (fields: ReadonlyArray<Field>, fieldNumber: number): number | undefined =>
  fields.find((f) => f.field === fieldNumber && f.value !== undefined)?.value;

/** The first length-delimited payload for a field number, if present. */
export const getBytes = (
  fields: ReadonlyArray<Field>,
  fieldNumber: number,
): Uint8Array | undefined =>
  fields.find((f) => f.field === fieldNumber && f.bytes !== undefined)?.bytes;

/** All length-delimited payloads for a field number (e.g. repeated fields). */
export const getAllBytes = (fields: ReadonlyArray<Field>, fieldNumber: number): Uint8Array[] =>
  fields.filter((f) => f.field === fieldNumber && f.bytes !== undefined).map((f) => f.bytes!);

/** All varint/fixed values for a field number. */
export const getAllVarints = (fields: ReadonlyArray<Field>, fieldNumber: number): number[] =>
  fields.filter((f) => f.field === fieldNumber && f.value !== undefined).map((f) => f.value!);

/** The first field number's scalar (varint or fixed-width), optionally of one wire type. */
const firstScalar = (
  fields: ReadonlyArray<Field>,
  fieldNumber: number,
  wire?: number,
): Field | undefined =>
  fields.find(
    (f) =>
      f.field === fieldNumber && f.value !== undefined && (wire === undefined || f.wire === wire),
  );

const viewOf = (bytes: Uint8Array): DataView =>
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

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
  fieldNumber: number,
  type: "uint64" | "int64" | "sint64" = "uint64",
): bigint | undefined => {
  const f = firstScalar(fields, fieldNumber);
  if (f === undefined) return undefined;
  const u = toUint64(f);
  return type === "int64" ? BigInt.asIntN(64, u) : type === "sint64" ? unzigzag(u) : u;
};

/** The first zigzag (`sint32`/`sint64`) varint for a field number. */
export const getSint = (fields: ReadonlyArray<Field>, fieldNumber: number): number | undefined => {
  const f = firstScalar(fields, fieldNumber, WIRE_VARINT);
  if (f === undefined) return undefined;
  return f.big !== undefined ? Number(unzigzag(f.big)) : unzigzagNumber(f.value!);
};

/** The first `double` (64-bit) for a field number. */
export const getDouble = (
  fields: ReadonlyArray<Field>,
  fieldNumber: number,
): number | undefined => {
  const f = firstScalar(fields, fieldNumber, WIRE_I64);
  return f === undefined ? undefined : viewOf(f.raw!).getFloat64(0, true);
};

/** The first `float` (32-bit) for a field number. */
export const getFloat = (fields: ReadonlyArray<Field>, fieldNumber: number): number | undefined => {
  const f = firstScalar(fields, fieldNumber, WIRE_I32);
  return f === undefined ? undefined : viewOf(f.raw!).getFloat32(0, true);
};

/** How the elements of a repeated scalar field are encoded. */
export type PackedType = "varint" | "sint" | "fixed32" | "fixed64" | "float" | "double";

const PACKED_SIZE: Record<PackedType, number> = {
  varint: 0,
  sint: 0,
  fixed32: 4,
  float: 4,
  fixed64: 8,
  double: 8,
};

/** How to read one element of a packed run, or the value of one unpacked field. */
const READ_ELEMENT: Record<PackedType, (r: ProtobufReader.ProtobufReader) => number> = {
  varint: (r) => r.uint64Number(),
  sint: (r) => r.sint64Number(),
  fixed32: (r) => r.fixed32(),
  float: (r) => r.float(),
  fixed64: (r) => r.fixed64Number(),
  double: (r) => r.double(),
};

/** The elements of one packed run. */
const readRun = (bytes: Uint8Array, type: PackedType, out: number[]): void => {
  const size = PACKED_SIZE[type];
  if (size !== 0 && bytes.length % size !== 0)
    throw codecError("Malformed", `protobuf: packed ${type} run of ${bytes.length} bytes`, 0);
  const r = ProtobufReader.make(bytes);
  const read = READ_ELEMENT[type];
  rethrowing(() => {
    while (!r.isDone()) out.push(read(r));
  }, readError(0));
};

/**
 * All values of a repeated scalar field, whether packed (length-delimited
 * runs) or not (one field per value): parsers must accept both. `fixed64` and
 * varints are exact up to 2^53. Throws a positioned `IworkError` on a
 * malformed packed run.
 */
export const getPacked = (
  fields: ReadonlyArray<Field>,
  fieldNumber: number,
  type: PackedType,
): number[] => {
  const size = PACKED_SIZE[type];
  const wire = size === 0 ? WIRE_VARINT : size === 8 ? WIRE_I64 : WIRE_I32;
  const out: number[] = [];
  for (const f of fields) {
    if (f.field !== fieldNumber) continue;
    if (f.bytes !== undefined) readRun(f.bytes, type, out);
    else if (f.wire === wire)
      out.push(
        size !== 0
          ? READ_ELEMENT[type](ProtobufReader.make(f.raw!))
          : type === "sint"
            ? unzigzagNumber(f.value!)
            : f.value!,
      );
  }
  return out;
};

const decoder = new TextDecoder();

/** Decode a length-delimited payload as a UTF-8 string. */
export const decodeUtf8 = (bytes: Uint8Array): string => decoder.decode(bytes);
