/**
 * The shared benchmark harness: runs every case of a group many times,
 * interleaved so that GC pressure and JIT warm-up fall on each case alike,
 * and reports the median and best time per run, the throughput over the
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
  sink = undefined;
  gc();
  const before = heapAndBuffers();
  const value = run();
  sink = value instanceof Promise ? await value : value;
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

/** Run every case a few times, so the timed rounds start warm. */
const warmUp = async (cases: ReadonlyArray<Case>): Promise<void> => {
  for (let i = 0; i < 3; i++) for (const c of cases) await time(c.run);
};

/**
 * Time the cases in rounds, every case once a round, for at least
 * `minRounds` rounds and until {@link budget} ms have passed (at most 1000).
 */
const sampleRounds = async (
  cases: ReadonlyArray<Case>,
  minRounds: number,
): Promise<{ readonly samples: Array<Array<number>>; readonly rounds: number }> => {
  const samples = cases.map((): Array<number> => []);
  const deadline = performance.now() + budget;
  let rounds = 0;
  while (rounds < minRounds || (performance.now() < deadline && rounds < 1000)) {
    for (let i = 0; i < cases.length; i++) samples[i]!.push(await time(cases[i]!.run));
    rounds++;
  }
  return { samples, rounds };
};

/** Each case's result's memory, measured one case at a time. */
const memory = async (cases: ReadonlyArray<Case>): Promise<Array<number | undefined>> => {
  const out: Array<number | undefined> = [];
  for (const c of cases) out.push(await retained(c.run));
  return out;
};

const megabytes = (bytes: number | undefined): string =>
  bytes === undefined ? "–" : (bytes / 1e6).toFixed(1);

/** A group's results as a Markdown table. */
const printTable = (
  group: Group,
  samples: ReadonlyArray<ReadonlyArray<number>>,
  heaps: ReadonlyArray<number | undefined>,
  rounds: number,
): void => {
  const medians = samples.map(median);
  const fastest = Math.min(...medians);
  const mb = group.bytes / 1e6;
  console.log(`## ${group.name} (${mb.toFixed(2)} MB, ${rounds} rounds)\n`);
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

/** Run each group's cases interleaved for {@link budget} ms and print a table. */
export const runGroups = async (title: string, groups: ReadonlyArray<Group>): Promise<void> => {
  console.log(`\n# ${title}\n`);
  for (const group of groups.filter((g) => g.name.includes(filter))) {
    await warmUp(group.cases);
    const { samples, rounds } = await sampleRounds(group.cases, group.minRounds ?? 15);
    printTable(group, samples, await memory(group.cases), rounds);
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
