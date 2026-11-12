/**
 * Text encoding detection and decoding for import (#188 §2), on effect-ext's
 * `/Encoding` (owner decision: depend on it; it imports only `effect`). A
 * caller with bytes of unknown encoding asks {@link detectEncoding} what they
 * look like, shows the guess, and decodes with {@link decodeText}, the
 * detected encoding or one the user picked. `contentToText`'s UTF-8 decoding
 * is unchanged: this is the opt-in path.
 */

import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import { Encoding } from "@thomasfosterau/effect-ext/Encoding";
import { type Content, ParseError, text, type Text } from "../index.ts";

/** How much of the input {@link detectEncoding} looks at: the first 64 KiB, as `detect`'s sniffers do. */
export const ENCODING_SAMPLE_BYTES = 64 * 1024;

/** How many leading bytes the UTF-16 check counts zero bytes over. */
const UTF16_SAMPLE_BYTES = 4096;

/** What {@link detectEncoding} found: the encoding, how sure it is, why, and whether a byte-order mark says so. */
export interface DetectedEncoding {
  /** The encoding's WHATWG name (`"UTF-8"`, `"UTF-16LE"`, `"windows-1252"`, …), as `decodeText` takes it. */
  readonly encoding: Encoding.EncodingName;
  /**
   * How sure the guess is, from 0 to 1: 1 for a byte-order mark, 0.95 for
   * valid UTF-8 with non-ASCII text, 0.9 for ASCII only, 0.7 for UTF-16 told
   * by its zero bytes, 0.5 for the Windows-1252 fallback.
   */
  readonly confidence: number;
  /** A short reason a UI can show ("UTF-8 byte-order mark", "not valid UTF-8 at byte 312"). */
  readonly evidence: string;
  /** Whether the input starts with a byte-order mark, which `decodeText` strips. */
  readonly bom: boolean;
}

/** The length of the UTF-8 sequence a lead byte starts: 1 to 4, or 0 for a continuation byte. */
const sequenceLength = (byte: number): number =>
  byte < 0x80 ? 1 : byte < 0xc0 ? 0 : byte < 0xe0 ? 2 : byte < 0xf0 ? 3 : 4;

/**
 * The first {@link ENCODING_SAMPLE_BYTES} of `bytes`, cut back to the last
 * whole UTF-8 sequence, so a character the sample's end splits isn't taken
 * for invalid UTF-8.
 */
const utf8Sample = (bytes: Uint8Array): Uint8Array => {
  if (bytes.length <= ENCODING_SAMPLE_BYTES) return bytes;
  const sample = bytes.subarray(0, ENCODING_SAMPLE_BYTES);
  // the last lead byte is among the last four; a sequence it can't finish is cut
  const tail = Array.from(sample.subarray(sample.length - 4));
  const lead = tail.findLastIndex((b) => sequenceLength(b) > 0);
  if (lead === -1) return sample;
  const at = sample.length - 4 + lead;
  return at + sequenceLength(tail[lead] ?? 0) > sample.length ? sample.subarray(0, at) : sample;
};

/** The share of a sample's bytes at even and at odd offsets that are zero. */
interface ZeroShares {
  readonly even: number;
  readonly odd: number;
}

/** The share of `bytes`' first {@link UTF16_SAMPLE_BYTES} at even and at odd offsets that are zero. */
const zeroShares = (bytes: Uint8Array): ZeroShares => {
  const sample = bytes.subarray(0, UTF16_SAMPLE_BYTES);
  const zeros = (parity: number): number =>
    sample.filter((b, i) => b === 0 && i % 2 === parity).length;
  const half = Math.max(1, Math.floor(sample.length / 2));
  return { even: zeros(0) / half, odd: zeros(1) / half };
};

/**
 * UTF-16 without a byte-order mark, told by its zero bytes: text that is
 * mostly Latin script has a zero high byte in nearly every code unit, at odd
 * offsets for little-endian and even ones for big-endian.
 */
const utf16ByZeros = (bytes: Uint8Array): Option.Option<DetectedEncoding> => {
  if (bytes.length < 4) return Option.none();
  const { even, odd } = zeroShares(bytes);
  return odd > 0.4 && even < 0.05
    ? Option.some({
        encoding: "UTF-16LE",
        confidence: 0.7,
        evidence: "zero bytes at odd offsets (UTF-16LE text)",
        bom: false,
      })
    : even > 0.4 && odd < 0.05
      ? Option.some({
          encoding: "UTF-16BE",
          confidence: 0.7,
          evidence: "zero bytes at even offsets (UTF-16BE text)",
          bom: false,
        })
      : Option.none();
};

/** Whether every byte is ASCII. */
const isAscii = (bytes: Uint8Array): boolean => bytes.every((b) => b < 0x80);

/** The guess for bytes with no byte-order mark: UTF-16 by its zeros, UTF-8 if it is valid, else Windows-1252. */
const withoutBom = (bytes: Uint8Array): Effect.Effect<DetectedEncoding> =>
  Option.match(utf16ByZeros(bytes), {
    onSome: Effect.succeed,
    onNone: () => {
      const sample = utf8Sample(bytes);
      return Effect.match(Encoding.decode(sample, { encoding: "UTF-8", fatal: true }), {
        onSuccess: (): DetectedEncoding =>
          isAscii(sample)
            ? {
                encoding: "UTF-8",
                confidence: 0.9,
                evidence: "ASCII only, read as UTF-8",
                bom: false,
              }
            : { encoding: "UTF-8", confidence: 0.95, evidence: "valid UTF-8", bom: false },
        onFailure: (error): DetectedEncoding => ({
          encoding: "windows-1252",
          confidence: 0.5,
          evidence: `not valid UTF-8${Predicate.isTagged(error, "DecodeError") ? ` at byte ${error.offset}` : ""}; read as Windows-1252`,
          bom: false,
        }),
      });
    },
  });

/**
 * The text encoding `content` looks like, from its first
 * {@link ENCODING_SAMPLE_BYTES}: a byte-order mark (UTF-8, UTF-16LE,
 * UTF-16BE) settles it; otherwise UTF-16 told by its zero bytes, then UTF-8
 * when the sample is valid UTF-8, and Windows-1252 (which decodes any bytes,
 * and is what such text most often is) when it is not. Text content is
 * already decoded, so it is UTF-8 with full confidence. Never fails: the
 * guess carries its confidence and evidence for a UI to show and the user to
 * override.
 *
 * ```ts
 * const guess = yield* detectEncoding(bytes(data));
 * // { encoding: "windows-1252", confidence: 0.5, evidence: "not valid UTF-8 at byte 312; …", bom: false }
 * ```
 */
export const detectEncoding = (content: Content): Effect.Effect<DetectedEncoding> =>
  Predicate.isTagged(content, "Text")
    ? Effect.succeed({ encoding: "UTF-8", confidence: 1, evidence: "already text", bom: false })
    : Option.match(Encoding.sniffBom(content.bytes), {
        onSome: (bom) =>
          Effect.succeed<DetectedEncoding>({
            encoding: bom.encoding,
            confidence: 1,
            evidence: `${bom.encoding} byte-order mark`,
            bom: true,
          }),
        onNone: () => withoutBom(content.bytes),
      });

/** Options for {@link decodeText}. */
export interface DecodeTextOptions {
  /**
   * The encoding to decode with, by its WHATWG name; when omitted, the one
   * {@link detectEncoding} detects. Every single-byte encoding, UTF-8 and
   * UTF-16 always decode; a CJK encoding decodes through the platform's
   * `TextDecoder` where it has one (Node and browsers do), and otherwise needs
   * its tables provided (effect-ext's `tablesLayer`).
   */
  readonly encoding?: Encoding.EncodingName;
}

/** A decoding failure as the `ParseError` a reader would give, positioned at the byte it failed at. */
const decodeFailure =
  (encoding: Encoding.EncodingName) =>
  (error: Encoding.DecodeError | Encoding.UnsupportedEncodingError): ParseError =>
    Match.valueTags(error, {
      DecodeError: (e) =>
        new ParseError({
          format: "text",
          reason: `not valid ${encoding} at byte ${e.offset}: ${e.message}`,
          code: "MalformedText",
          position: { offset: e.offset },
          cause: e,
        }),
      UnsupportedEncodingError: (e) =>
        new ParseError({
          format: "text",
          reason: `cannot decode ${encoding}: ${e.message}`,
          code: "Unsupported",
          cause: e,
        }),
    });

/**
 * `content` as text, decoded with `options.encoding` or else the encoding
 * {@link detectEncoding} detects, a byte-order mark stripped. The decoding is
 * strict, as the readers are lossless: a byte sequence the encoding doesn't
 * define fails with a `ParseError` of code `MalformedText` positioned at the
 * offset of the byte that breaks it, never a U+FFFD, and an encoding nothing
 * here can decode (a CJK one with neither a platform decoder nor its tables)
 * fails with code `Unsupported`. Text content
 * is returned as it is. Hand the result to any text reader (`Csv.format`,
 * `Rtf.format`).
 *
 * ```ts
 * const input = yield* decodeText(bytes(data), { encoding: "windows-1252" });
 * const doc = yield* Csv.makeCsvReader().read(input);
 * ```
 */
export const decodeText = (
  content: Content,
  options: DecodeTextOptions = {},
): Effect.Effect<Text, ParseError> =>
  Predicate.isTagged(content, "Text")
    ? Effect.succeed(content)
    : Effect.gen(function* () {
        const encoding = options.encoding ?? (yield* detectEncoding(content)).encoding;
        const decoded = yield* Effect.mapError(
          Encoding.decode(content.bytes, { encoding, fatal: true, bomHandling: "strip" }),
          decodeFailure(encoding),
        );
        return text(decoded);
      });

/** The encodings {@link decodeText} takes, by their WHATWG names (effect-ext's list). */
export const ENCODING_NAMES: ReadonlyArray<Encoding.EncodingName> = Arr.copy(
  Encoding.ENCODING_NAMES,
);
