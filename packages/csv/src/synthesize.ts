/**
 * Synthetic tabular data generation, useful for testing and demos.
 * Supports seeded generation for reproducibility.
 */

import { Effect } from "effect";
import { Sheet, Workbook, cell } from "@effect-pandoc/core";

export interface SynthesisSpec {
  readonly columns: ReadonlyArray<string> | number;
  readonly quantity: number;
  readonly seed?: number;
  readonly fieldLengthRange?: readonly [number, number];
}

/** The raw result of synthesis: headers plus rows of string fields */
export interface SynthesizedTable {
  readonly headers: ReadonlyArray<string>;
  readonly rows: ReadonlyArray<ReadonlyArray<string>>;
}

class SeedableRng {
  private value: number;

  constructor(seed: number) {
    this.value = seed;
  }

  next(): number {
    const multiplier = 48271;
    const modulus = 2147483647;
    this.value = (this.value * multiplier) % modulus;
    return this.value / modulus;
  }

  between(min: number, max: number): number {
    return Math.floor(this.next() * (max - min + 1)) + min;
  }
}

const generateRandomContent = (
  lengthRange: readonly [number, number],
  rng: SeedableRng | null
): Effect.Effect<string> =>
  Effect.sync(() => {
    const chars =
      "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    const len = rng
      ? rng.between(lengthRange[0], lengthRange[1])
      : Math.floor(Math.random() * (lengthRange[1] - lengthRange[0] + 1)) +
        lengthRange[0];

    let result = "";
    for (let i = 0; i < len; i++) {
      const idx = rng
        ? rng.between(0, chars.length - 1)
        : Math.floor(Math.random() * chars.length);
      result += chars[idx]!;
    }
    return result;
  });

/**
 * Generate a table of random string data according to the spec.
 */
export const synthesizeTable = (
  spec: SynthesisSpec
): Effect.Effect<SynthesizedTable, never> =>
  Effect.gen(function* () {
    const rawLengthRange = spec.fieldLengthRange ?? [5, 20];
    const minRaw = rawLengthRange[0];
    const maxRaw = rawLengthRange[1];
    const lower = Math.min(minRaw, maxRaw);
    const upper = Math.max(minRaw, maxRaw);
    const min = Math.max(0, lower);
    const max = Math.max(min, upper);
    const lengthRange: readonly [number, number] = [min, max];
    const rng = spec.seed !== undefined ? new SeedableRng(spec.seed) : null;

    const columns = Array.isArray(spec.columns)
      ? spec.columns
      : Array.from({ length: spec.columns as number }, (_, i) => `col${i}`);

    const rows: string[][] = [];

    const rawQuantity = spec.quantity;
    const quantity =
      typeof rawQuantity === "number" &&
      Number.isFinite(rawQuantity) &&
      rawQuantity > 0
        ? Math.floor(rawQuantity)
        : 0;

    for (let rowIdx = 0; rowIdx < quantity; rowIdx++) {
      const row: string[] = [];
      for (let colIdx = 0; colIdx < columns.length; colIdx++) {
        const content = yield* generateRandomContent(lengthRange, rng);
        row.push(content);
      }
      rows.push(row);
    }

    return { headers: columns, rows };
  });

/**
 * Generate a single-sheet Workbook of random string data according to the
 * spec.
 */
export const synthesizeWorkbook = (
  spec: SynthesisSpec,
  sheetName: string = "Sheet1"
): Effect.Effect<Workbook, never> =>
  Effect.map(
    synthesizeTable(spec),
    ({ headers, rows }) =>
      new Workbook({
        sheets: [
          new Sheet({
            name: sheetName,
            headers,
            rows: rows.map((row) => row.map(cell.str)),
          }),
        ],
      })
  );
