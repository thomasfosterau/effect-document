/**
 * The shared benchmark harness: runs every case of a group many times, one
 * case after another (each warmed up, then sampled for its share of the
 * group's time), and reports the median and best time per run, the throughput over the
 * input's size, each case's ratio to the fastest, and the heap its result
 * holds.
 *
 * Plain Node (no Effect runtime around the timing loop): a case is a
 * function returning a value or a promise, and the harness keeps the value
 * alive so the engine cannot drop the work.
 */

import * as Arr from "effect/Array";
import * as Order from "effect/Order";

/** One competitor in a group: a name and the work one timed run does. */
export interface Case {
  readonly name: string;
  readonly run: () => unknown;
}

/** A set of cases doing the same work over the same input. */
export interface Group {
  readonly name: string;
  /** The input's size in bytes, for the throughput column. */
  readonly bytes: number;
  readonly cases: ReadonlyArray<Case>;
  /** The fewest rounds to run, however long they take (default 15). */
  readonly minRounds?: number | undefined;
}

/** How long to keep sampling one group, in milliseconds (`BENCH_TIME`, default 3000). */
const budget = Number(process.env["BENCH_TIME"] ?? 3000);
/** Only groups whose name contains this (`BENCH_FILTER`). */
const filter = process.env["BENCH_FILTER"] ?? "";

/** `global.gc`, when Node runs with `--expose-gc` (the `vp run bench*` tasks do). */
const gc = globalThis.gc;

let sink: unknown;

const time = async (run: () => unknown): Promise<number> => {
  // drop the previous case's result first: kept alive, it would be copied by
  // the collections this case triggers, charging one case for another's output
  sink = undefined;
  const start = performance.now();
  const value = run();
  sink = value instanceof Promise ? await value : value;
  return performance.now() - start;
};

/** The JS heap in use plus the `ArrayBuffer` bytes outside it (a writer's output lives there). */
const heapAndBuffers = (): number => {
  const { heapUsed, arrayBuffers } = process.memoryUsage();
  return heapUsed + arrayBuffers;
};

/**
 * The memory one run's result holds, in bytes: the heap after a collection
 * with the result alive, less the heap after one without it. Needs
 * `--expose-gc`; `undefined` without it.
 */
const retained = async (run: () => unknown): Promise<number | undefined> => {
  if (gc === undefined) return undefined;
  // twice each time: one collection can leave the previous one's work unfinished
  sink = undefined;
  gc();
  gc();
  const before = heapAndBuffers();
  const value = run();
  sink = value instanceof Promise ? await value : value;
  gc();
  gc();
  const after = heapAndBuffers();
  sink = undefined;
  return Math.max(0, after - before);
};

const median = (xs: ReadonlyArray<number>): number => {
  const sorted = Arr.sort(xs, Order.Number);
  return sorted[Math.floor(sorted.length / 2)]!;
};

const pad = (s: string, n: number) => s.padEnd(n);
const padL = (s: string, n: number) => s.padStart(n);

/**
 * Time one case: a few warm-up runs, then samples for at least `minRounds`
 * runs and until `budget` ms have passed (at most 1000). Each case is sampled
 * on its own, not interleaved with the others: interleaved, a case is charged
 * for the collections the garbage of the case before it brings on, which
 * penalises whichever allocates most.
 */
const sampleCase = async (
  c: Case,
  minRounds: number,
  caseBudget: number,
): Promise<Array<number>> => {
  for (let i = 0; i < 3; i++) await time(c.run);
  const samples: Array<number> = [];
  const deadline = performance.now() + caseBudget;
  while (samples.length < minRounds || (performance.now() < deadline && samples.length < 1000))
    samples.push(await time(c.run));
  sink = undefined;
  return samples;
};

/** Every case's samples, the group's time shared between them. */
const sampleGroup = async (
  cases: ReadonlyArray<Case>,
  minRounds: number,
): Promise<Array<Array<number>>> => {
  const out: Array<Array<number>> = [];
  for (const c of cases) out.push(await sampleCase(c, minRounds, budget / cases.length));
  return out;
};

/**
 * Each case's result's memory, measured one case at a time: the median of
 * three readings, as a collection finishing work left by an earlier case can
 * shrink the heap under one reading.
 */
const memory = async (cases: ReadonlyArray<Case>): Promise<Array<number | undefined>> => {
  const out: Array<number | undefined> = [];
  for (const c of cases) {
    const readings: Array<number> = [];
    for (let i = 0; i < 3; i++) {
      const bytes = await retained(c.run);
      if (bytes !== undefined) readings.push(bytes);
    }
    out.push(Arr.match(readings, { onEmpty: () => undefined, onNonEmpty: median }));
  }
  return out;
};

const megabytes = (bytes: number | undefined): string =>
  bytes === undefined ? "–" : (bytes / 1e6).toFixed(1);

/** A group's results as a Markdown table. */
const printTable = (
  group: Group,
  samples: ReadonlyArray<ReadonlyArray<number>>,
  heaps: ReadonlyArray<number | undefined>,
): void => {
  const medians = samples.map(median);
  const fastest = Math.min(...medians);
  const mb = group.bytes / 1e6;
  const runs = samples.map((s) => s.length);
  console.log(
    `## ${group.name} (${mb.toFixed(2)} MB, ${Math.min(...runs)}–${Math.max(...runs)} runs a case)\n`,
  );
  console.log(
    `| ${pad("case", 34)} | ${padL("median ms", 10)} | ${padL("best ms", 9)} | ${padL("MB/s", 8)} | ${padL("vs fastest", 10)} | ${padL("result MB", 9)} |`,
  );
  console.log(
    `| ${"-".repeat(34)} | ${"-".repeat(9)}: | ${"-".repeat(8)}: | ${"-".repeat(7)}: | ${"-".repeat(9)}: | ${"-".repeat(8)}: |`,
  );
  group.cases.forEach((c, i) => {
    const m = medians[i]!;
    console.log(
      `| ${pad(c.name, 34)} | ${padL(m.toFixed(2), 10)} | ${padL(Math.min(...samples[i]!).toFixed(2), 9)} | ${padL((mb / (m / 1000)).toFixed(1), 8)} | ${padL(`${(m / fastest).toFixed(2)}x`, 10)} | ${padL(megabytes(heaps[i]), 9)} |`,
    );
  });
  console.log("");
};

/**
 * A group, or how to build it. A built group's inputs stay alive while every
 * later group runs, and a large live heap slows the collections that
 * allocation-heavy cases trigger; a group built only when it runs (and
 * dropped after) measures each case against its own inputs only.
 */
export type GroupSource = Group | { readonly name: string; readonly build: () => Group };

const build = (source: GroupSource): Group => ("build" in source ? source.build() : source);

/** Run each group's cases interleaved for {@link budget} ms and print a table. */
export const runGroups = async (
  title: string,
  groups: ReadonlyArray<GroupSource>,
): Promise<void> => {
  console.log(`\n# ${title}\n`);
  for (const source of groups.filter((g) => g.name.includes(filter))) {
    const group = build(source);
    const samples = await sampleGroup(group.cases, group.minRounds ?? 15);
    printTable(group, samples, await memory(group.cases));
  }
  return void sink;
};

/** A deterministic PRNG (mulberry32), so every run benchmarks the same data. */
export const rng = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
