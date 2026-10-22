import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { ByteSize, Effect, FileSystem, Result } from "effect";
import { unzipSync, zipSync } from "fflate";
import { bytes, type ParseError } from "@thomasfosterau/effect-document";
import { decodeArchiveStream, decodeIwa } from "../src/archive.js";
import { openBundle, openBundleDirectory } from "../src/bundle.js";
import { IworkError } from "../src/errors.js";
import { chunk, dechunk } from "../src/iwa.js";
import {
  getBigInt, getDouble, getFloat, getPacked, getSint, getVarint, parseMessage, readVarint,
} from "../src/protobuf.js";
import { compressBlock, decompressBlock } from "../src/snappy.js";
import * as Keynote from "../src/keynote.js";
import { f32, f64, fixedField, i64, lenField, record, varint, varintField } from "./encode.js";

const fixture = (name: string): Uint8Array =>
  new Uint8Array(readFileSync(`${import.meta.dir}/fixtures/${name}`));

/** The `IworkError` a codec call throws (anything else, or no failure, fails the test). */
const failure = (f: () => unknown): IworkError => {
  try {
    f();
  } catch (e) {
    if (e instanceof IworkError) return e;
    throw e;
  }
  throw new Error("expected an IworkError");
};

// ----------------------------------------------------------------------------

describe("Snappy: malformed blocks fail with a typed error", () => {
  test("a huge preamble is refused before allocating", () => {
    // ff ff ff ff 0f declares 4 GiB
    const huge = failure(() => decompressBlock(new Uint8Array([0xff, 0xff, 0xff, 0xff, 0x0f])));
    expect(huge.reason).toBe("LimitExceeded");
    // under a raised limit it is still more than the input can expand to
    const lying = failure(() =>
      decompressBlock(new Uint8Array([0xff, 0xff, 0xff, 0xff, 0x0f, 0x00, 0x61]), { maxLength: 2 ** 32 })
    );
    expect(lying.reason).toBe("Malformed");
    expect(lying.message).toMatch(/more than 2 bytes of input can produce/);
    expect(failure(() => decompressBlock(new Uint8Array([0x80, 0x80, 0x80, 0x80, 0x80, 0x01]))).message).toMatch(
      /preamble longer than 5 bytes/
    );
    expect(failure(() => decompressBlock(new Uint8Array([]))).reason).toBe("Truncated");
  });

  test("copy offsets of 0 or past the output written are rejected", () => {
    // preamble 5; literal "a"; copy (len 4) at offset 0 / 2
    const zero = failure(() => decompressBlock(new Uint8Array([5, 0x00, 0x61, 0x01, 0])));
    expect(zero.reason).toBe("Malformed");
    expect(zero.offset).toBe(3);
    expect(zero.message).toMatch(/copy offset 0/);
    expect(failure(() => decompressBlock(new Uint8Array([5, 0x00, 0x61, 0x01, 2]))).message).toMatch(
      /copy offset 2 is outside the 1 bytes written/
    );
    // 2- and 4-byte offset forms too
    expect(failure(() => decompressBlock(new Uint8Array([5, 0x00, 0x61, 0x0e, 9, 0]))).reason).toBe("Malformed");
    expect(failure(() => decompressBlock(new Uint8Array([5, 0x00, 0x61, 0x0f, 9, 0, 0, 0]))).reason).toBe(
      "Malformed"
    );
  });

  test("overruns of the declared length or the input are rejected", () => {
    // copy of 4 into a 3-byte output
    expect(failure(() => decompressBlock(new Uint8Array([3, 0x00, 0x61, 0x01, 1]))).message).toMatch(/overruns/);
    // literal of 2 into a 1-byte output
    expect(failure(() => decompressBlock(new Uint8Array([1, 0x04, 0x61, 0x62]))).message).toMatch(/overruns/);
    // literal of 5 with only 2 bytes left
    expect(failure(() => decompressBlock(new Uint8Array([5, 0x10, 0x61, 0x62]))).reason).toBe("Truncated");
    // a copy tag with its offset byte missing
    expect(failure(() => decompressBlock(new Uint8Array([5, 0x00, 0x61, 0x01]))).reason).toBe("Truncated");
    // output shorter than the preamble declares
    const short = failure(() => decompressBlock(new Uint8Array([5, 0x00, 0x61])));
    expect(short.reason).toBe("Truncated");
    expect(short.message).toMatch(/produced 1 bytes, the preamble declared 5/);
  });

  test("valid overlapping copies still expand (run-length)", () => {
    // literal "a", then copy len 8 at offset 1
    expect(new TextDecoder().decode(decompressBlock(new Uint8Array([9, 0x00, 0x61, 0x11, 1])))).toBe("aaaaaaaaa");
  });

  test("dechunk positions a block's error in the .iwa file and caps the stream", () => {
    const iwa = new Uint8Array([0x00, 5, 0, 0, 5, 0x00, 0x61, 0x01, 0]);
    const e = failure(() => dechunk(iwa));
    expect(e.offset).toBe(4 + 3);
    const big = chunk(new Uint8Array(1000));
    expect(failure(() => dechunk(big, { maxLength: 999 })).reason).toBe("LimitExceeded");
    expect(dechunk(big, { maxLength: 1000 }).length).toBe(1000);
  });
});

describe("archive stream: declared lengths are checked", () => {
  test("a truncated payload fails, naming the object", () => {
    const stream = new Uint8Array(record(7, [{ type: 1, payload: [1, 2, 3, 4, 5] }])).subarray(0, -2);
    const e = failure(() => decodeArchiveStream(stream));
    expect(e.reason).toBe("Truncated");
    expect(e.objectId).toBe(7n);
    expect(e.message).toMatch(/object 7, offset \d+: payload needs 5 bytes, only 3 left/);
  });

  test("a truncated ArchiveInfo fails", () => {
    const stream = new Uint8Array(record(7, [{ type: 1, payload: [] }]));
    expect(failure(() => decodeArchiveStream(stream.subarray(0, 3))).reason).toBe("Truncated");
  });

  test("a missing identifier, type or length is an error, not 0", () => {
    expect(failure(() => decodeArchiveStream(new Uint8Array(record(undefined, [])))).message).toMatch(
      /no identifier/
    );
    const noLength = [...varintField(1, 7), ...lenField(2, varintField(1, 1))];
    expect(
      failure(() => decodeArchiveStream(new Uint8Array([...varint(noLength.length), ...noLength]))).message
    ).toMatch(/MessageInfo has no length/);
  });

  test("identifiers above 2^53 are exact", () => {
    const id = 2n ** 60n + 1n;
    const [obj] = decodeArchiveStream(new Uint8Array(record(id, [{ type: 1, payload: [8, 1] }])));
    expect(obj!.identifier).toBe(id);
  });

  test("decodeIwa returns a Result", () => {
    const ok = decodeIwa(chunk(new Uint8Array(record(3, [{ type: 2, payload: [8, 1] }]))));
    expect(Result.isSuccess(ok) && ok.success[0]!.identifier).toBe(3n);
    const bad = decodeIwa(new Uint8Array([0x01]));
    expect(Result.isFailure(bad) && bad.failure._tag).toBe("IworkError");
  });
});

describe("Protobuf: typed scalar accessors", () => {
  test("doubles and floats keep their bits", () => {
    const fields = parseMessage(
      new Uint8Array([...fixedField(1, 1, f64(-1234.5678)), ...fixedField(2, 5, f32(0.25))])
    );
    expect(getDouble(fields, 1)).toBe(-1234.5678);
    expect(getFloat(fields, 2)).toBe(0.25);
    expect(getDouble(fields, 2)).toBeUndefined();
  });

  test("64-bit integers are exact as bigints", () => {
    const max = 2n ** 64n - 1n;
    const fields = parseMessage(
      new Uint8Array([
        ...varintField(1, max),
        ...varintField(2, BigInt.asUintN(64, -5n)), // int64 -5: a 10-byte varint
        ...varintField(3, 9), // sint64 -5 (zigzag)
        ...fixedField(4, 1, i64(-(2n ** 62n))),
        ...varintField(5, 2n ** 53n + 1n),
      ])
    );
    expect(getBigInt(fields, 1)).toBe(max);
    expect(getBigInt(fields, 2, "int64")).toBe(-5n);
    expect(getBigInt(fields, 3, "sint64")).toBe(-5n);
    expect(getSint(fields, 3)).toBe(-5);
    expect(getBigInt(fields, 4, "int64")).toBe(-(2n ** 62n));
    expect(getBigInt(fields, 5)).toBe(2n ** 53n + 1n);
    // the number view is still there (inexact above 2^53)
    expect(getVarint(fields, 3)).toBe(9);
  });

  test("packed and unpacked repeated fields", () => {
    const doubles = [...new Uint8Array(f64(1.5)), ...new Uint8Array(f64(-2))];
    const fields = parseMessage(
      new Uint8Array([
        ...lenField(1, [...varint(1), ...varint(300), ...varint(5)]),
        ...varintField(1, 7),
        ...lenField(2, doubles),
        ...fixedField(2, 1, f64(3)),
        ...lenField(3, [...varint(3), ...varint(4)]),
      ])
    );
    expect(getPacked(fields, 1, "varint")).toEqual([1, 300, 5, 7]);
    expect(getPacked(fields, 2, "double")).toEqual([1.5, -2, 3]);
    expect(getPacked(fields, 3, "sint")).toEqual([-2, 2]);
    const bad = parseMessage(new Uint8Array(lenField(1, [1, 2, 3])));
    expect(failure(() => getPacked(bad, 1, "double")).reason).toBe("Malformed");
    expect(failure(() => getPacked(parseMessage(new Uint8Array(lenField(1, [0x80]))), 1, "varint")).reason).toBe(
      "Truncated"
    );
  });

  test("wire errors are IworkErrors with an offset", () => {
    const e = failure(() => parseMessage(new Uint8Array([0x08, 0x01, 0x12, 0x05, 0x68])));
    expect(e.reason).toBe("Truncated");
    expect(e.offset).toBe(4);
    expect(failure(() => readVarint(new Uint8Array([0x80]), 0)).reason).toBe("Truncated");
  });
});

describe("bundle: typed failures and inflation limits", () => {
  test("non-zip input is NotZip", () => {
    const r = openBundle(new TextEncoder().encode("not a zip at all"));
    expect(Result.isFailure(r) && r.failure.reason).toBe("NotZip");
  });

  test("only components are inflated; media is read on demand", () => {
    const zip = zipSync({
      "Index/Document.iwa": chunk(new Uint8Array(record(1, []))),
      "Data/big.bin": new Uint8Array(100_000),
    });
    const r = openBundle(zip, { limits: { maxEntrySize: 1000 } });
    if (Result.isFailure(r)) throw r.failure;
    const bundle = r.success;
    expect(Object.keys(bundle.components)).toEqual(["Index/Document.iwa"]);
    expect(bundle.entries).toContain("Data/big.bin");
    // the media entry is over the limit, so reading it fails instead of inflating
    const media = Effect.runSync(Effect.result(bundle.readEntry("Data/big.bin")));
    expect(Result.isFailure(media) && media.failure.reason).toBe("LimitExceeded");
    const doc = Effect.runSync(bundle.readEntry("Index/Document.iwa"));
    expect(doc.length).toBeGreaterThan(0);
  });

  test("entry count, entry size and total size limits", () => {
    const zip = zipSync({ "Index/A.iwa": new Uint8Array(600), "Index/B.iwa": new Uint8Array(600) });
    const reason = (limits: object) => {
      const r = openBundle(zip, { limits });
      return Result.isFailure(r) ? r.failure.reason : "ok";
    };
    expect(reason({})).toBe("ok");
    expect(reason({ maxEntries: 1 })).toBe("LimitExceeded");
    expect(reason({ maxEntrySize: 500 })).toBe("LimitExceeded");
    expect(reason({ maxTotalSize: 1000 })).toBe("LimitExceeded");
    // the inner Index.zip of older documents shares the budget
    const nested = zipSync({
      "Index.zip": zipSync({ "Index/A.iwa": new Uint8Array(600), "Index/B.iwa": new Uint8Array(600) }),
    });
    const r = openBundle(nested, { limits: { maxTotalSize: 1000 } });
    expect(Result.isFailure(r) && r.failure.reason).toBe("LimitExceeded");
  });

  test("an unzipped package directory opens through FileSystem", () => {
    const files: Record<string, Uint8Array> = unzipSync(fixture("simple-oneslide.key"), {
      filter: (f) => f.name.startsWith("Index/"),
    });
    const fs = FileSystem.layerNoop({
      readDirectory: () => Effect.succeed(["Index", ...Object.keys(files), "Data/x.jpg"]),
      stat: (path) =>
        Effect.succeed({
          type: "File",
          size: ByteSize.bytes(files[path.slice("/deck.key/".length)]?.length ?? 0),
        } as unknown as FileSystem.File.Info),
      readFile: (path) => Effect.succeed(files[path.slice("/deck.key/".length)]!),
    });
    const bundle = Effect.runSync(openBundleDirectory("/deck.key/").pipe(Effect.provide(fs)));
    expect(Object.keys(bundle.components).sort()).toEqual(Object.keys(files).sort());
    expect(bundle.entries).toContain("Data/x.jpg");
  });
});

describe("readers: component failures", () => {
  const corrupted = (name: string, data: Uint8Array): Uint8Array => {
    const files: Record<string, Uint8Array> = unzipSync(fixture("simple-oneslide.key"));
    files[name] = data;
    return zipSync(files);
  };

  test("name the component and keep the IworkError as the cause", () => {
    const deck = corrupted("Index/Slide-8060.iwa", new Uint8Array([0x00, 5, 0, 0, 1]));
    const r = Effect.runSync(Effect.result(Keynote.makeKeynoteReader().read(bytes(deck))));
    if (Result.isSuccess(r)) throw new Error("expected a failure");
    const e: ParseError = r.failure;
    expect(e.reason).toMatch(/^Failed to read keynote: Index\/Slide-8060\.iwa, offset 4: /);
    expect((e.cause as IworkError).reason).toBe("Truncated");
  });

  test("a bad payload names its object", () => {
    // a TSWP.StorageArchive (type 2001) whose payload has an unsupported wire type
    const slide = chunk(new Uint8Array(record(42, [{ type: 2001, payload: [0x0b] }])));
    const r = Effect.runSync(
      Effect.result(Keynote.makeKeynoteReader().read(bytes(corrupted("Index/Slide-8060.iwa", slide))))
    );
    expect(Result.isFailure(r) && r.failure.reason).toMatch(/Index\/Slide-8060\.iwa, object 42, offset 0/);
  });

  test("lenient mode skips the component with a warning", () => {
    const deck = corrupted("Index/Slide-8060.iwa", new Uint8Array([0x00, 5, 0, 0, 1]));
    const doc = Effect.runSync(Keynote.makeKeynoteReader({ lenient: true }).read(bytes(deck)));
    expect(Keynote.Keynote.is(doc)).toBe(true);
  });
});

// ----------------------------------------------------------------------------
// Fuzzing: random and mutated input must fail with an IworkError, never a
// defect (RangeError, TypeError, ...) or a hang. Seeded, so failures replay.
// ----------------------------------------------------------------------------

/** mulberry32: a small, seedable PRNG. */
const prng = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const randomBytes = (rand: () => number, max: number): Uint8Array =>
  new Uint8Array(Math.floor(rand() * max)).map(() => Math.floor(rand() * 256));

/** Flip, overwrite, truncate or splice a few bytes of a valid input. */
const mutate = (rand: () => number, input: Uint8Array): Uint8Array => {
  let out: Uint8Array = input.slice();
  const edits = 1 + Math.floor(rand() * 4);
  for (let i = 0; i < edits && out.length > 0; i++) {
    const at = Math.floor(rand() * out.length);
    switch (Math.floor(rand() * 4)) {
      case 0:
        out[at] = out[at]! ^ (1 << Math.floor(rand() * 8));
        break;
      case 1:
        out[at] = Math.floor(rand() * 256);
        break;
      case 2:
        out = out.slice(0, at);
        break;
      default:
        out = new Uint8Array([...out.subarray(0, at), ...randomBytes(rand, 8), ...out.subarray(at)]);
    }
  }
  return out;
};

/** Run `f`, which may succeed or throw only an `IworkError`. */
const survives = (f: () => unknown, input: Uint8Array): void => {
  try {
    f();
  } catch (e) {
    if (!(e instanceof IworkError)) {
      throw new Error(`defect on input [${Array.from(input).join(",")}]: ${String(e)}`);
    }
  }
};

describe("fuzz", () => {
  const iwa = fixture("simple-oneslide.iwa");
  const stream = dechunk(iwa);
  const block = compressBlock(stream.subarray(0, 512));

  test("decompressBlock", () => {
    const rand = prng(1);
    for (let i = 0; i < 3000; i++) {
      const input = i % 2 === 0 ? randomBytes(rand, 64) : mutate(rand, block);
      survives(() => decompressBlock(input), input);
    }
  });

  test("dechunk", () => {
    const rand = prng(2);
    for (let i = 0; i < 1000; i++) {
      const input = i % 2 === 0 ? randomBytes(rand, 64) : mutate(rand, iwa);
      survives(() => dechunk(input), input);
    }
  });

  test("parseMessage and readVarint", () => {
    const rand = prng(3);
    for (let i = 0; i < 3000; i++) {
      const input = randomBytes(rand, 48);
      survives(() => parseMessage(input), input);
      survives(() => readVarint(input, 0), input);
    }
  });

  test("decodeArchiveStream", () => {
    const rand = prng(4);
    for (let i = 0; i < 1000; i++) {
      const input = i % 2 === 0 ? randomBytes(rand, 64) : mutate(rand, stream);
      survives(() => decodeArchiveStream(input), input);
    }
  });
});
