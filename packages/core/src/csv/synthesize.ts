/**
 * Synthetic tabular data generation, useful for testing and demos.
 * Supports seeded generation for reproducibility.
 */

import * as Random from "effect/Random";
import * as Predicate from "effect/Predicate";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import { cell, type Doc, document, type FeaturesOf, trustAs, worksheet } from "../index.ts";
import { Csv } from "../profile/profiles.ts";

type CsvFeature = FeaturesOf<typeof Csv>;

/** What to synthesize: the columns (names, or a count named `col0…`), the row count, an optional seed for reproducible data (any number: its integer part modulo 2^31 - 1, 0 standing for 2^31 - 2), and the field-length range (default 5–20). */
export interface SynthesisSpec {
  readonly columns: ReadonlyArray<string> | number;
  readonly quantity: number;
  readonly seed?: number | undefined;
  readonly fieldLengthRange?: readonly [number, number] | undefined;
}

/** The raw result of synthesis: headers plus rows of string fields. */
export interface SynthesizedTable {
  readonly headers: ReadonlyArray<string>;
  readonly rows: ReadonlyArray<ReadonlyArray<string>>;
}

/** The Lehmer generator's prime modulus, 2^31 - 1: its states are the integers in [1, LEHMER_MODULUS - 1]. */
const LEHMER_MODULUS = 2147483647;

/**
 * A valid generator state for any seed: its integer part taken modulo
 * {@link LEHMER_MODULUS} into [0, LEHMER_MODULUS - 1], with 0 (a state the
 * generator never leaves: every field would be the shortest run of `a`s)
 * taken as LEHMER_MODULUS - 1. A seed already in [1, LEHMER_MODULUS - 1] is
 * its own state, so the tables of valid seeds are unchanged; a negative seed
 * no longer yields negative draws (empty fields), nor a non-finite one NaN.
 */
const lehmerState = (seed: number): number => {
  const whole = Number.isFinite(seed) ? Math.trunc(seed) : 0;
  const state = ((whole % LEHMER_MODULUS) + LEHMER_MODULUS) % LEHMER_MODULUS;
  return state === 0 ? LEHMER_MODULUS - 1 : state;
};

class SeedableRng {
  private value: number;

  constructor(seed: number) {
    this.value = lehmerState(seed);
  }

  next(): number {
    const multiplier = 48271;
    this.value = (this.value * multiplier) % LEHMER_MODULUS;
    return this.value / LEHMER_MODULUS;
  }

  between(min: number, max: number): number {
    return Math.floor(this.next() * (max - min + 1)) + min;
  }
}

const CHARS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

const generateRandomContent = (lengthRange: readonly [number, number], rng: SeedableRng): string =>
  // `Array.from`, not `Arr.makeBy`: a zero length must stay empty.
  Array.from({ length: rng.between(lengthRange[0], lengthRange[1]) }, () =>
    CHARS.charAt(rng.between(0, CHARS.length - 1)),
  ).join("");

/** Generate a table of random string data according to the spec. */
export const synthesizeTable = (spec: SynthesisSpec): Effect.Effect<SynthesizedTable> =>
  Effect.gen(function* () {
    const rawLengthRange = spec.fieldLengthRange ?? [5, 20];
    const lower = Math.min(rawLengthRange[0], rawLengthRange[1]);
    const upper = Math.max(rawLengthRange[0], rawLengthRange[1]);
    const min = Math.max(0, lower);
    const max = Math.max(min, upper);
    const lengthRange: readonly [number, number] = [min, max];
    // Unseeded runs draw their seed from Effect's `Random` service (a valid
    // seed for the Lehmer generator is in [1, 2^31 - 2]).
    const rng = new SeedableRng(spec.seed ?? (yield* Random.nextIntBetween(1, 2147483646)));

    const columns = Predicate.isNumber(spec.columns)
      ? Array.from({ length: spec.columns }, (_, i) => `col${i}`)
      : spec.columns;

    const rawQuantity = spec.quantity;
    const quantity = Number.isFinite(rawQuantity) && rawQuantity > 0 ? Math.floor(rawQuantity) : 0;
    // Row-major, one field at a time: a seed reproduces the same table.
    const rows = Array.from({ length: quantity }, () =>
      Arr.map(columns, () => generateRandomContent(lengthRange, rng)),
    );

    return { headers: columns, rows };
  });

/**
 * Generate a single-worksheet CSV-profile document of random string data.
 */
export const synthesizeDocument = (
  spec: SynthesisSpec,
  sheetName: string = "Sheet1",
): Effect.Effect<Doc<CsvFeature>> =>
  Effect.map(synthesizeTable(spec), ({ headers, rows }) =>
    trustAs<CsvFeature>(
      document([
        worksheet(
          sheetName,
          rows.map((row) => row.map((v) => cell.text(v))),
          headers,
        ),
      ]),
    ),
  );
