/**
 * The shared benchmark harness: runs every case of a group many times,
 * interleaved so that GC pressure and JIT warm-up fall on each case alike,
 * and reports the median and best time per run, the throughput over the
 * input's size, and each case's ratio to the fastest.
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
}

/** How long to keep sampling one group, in milliseconds (`BENCH_TIME`, default 3000). */
const budget = Number(process.env["BENCH_TIME"] ?? 3000);
/** Only groups whose name contains this (`BENCH_FILTER`). */
const filter = process.env["BENCH_FILTER"] ?? "";

let sink: unknown;

const time = async (run: () => unknown): Promise<number> => {
  const start = performance.now();
  const value = run();
  sink = value instanceof Promise ? await value : value;
  return performance.now() - start;
};

const median = (xs: ReadonlyArray<number>): number => {
  const sorted = Arr.sort(xs, Order.Number);
  return sorted[Math.floor(sorted.length / 2)]!;
};

const pad = (s: string, n: number) => s.padEnd(n);
const padL = (s: string, n: number) => s.padStart(n);

/** Run each group's cases interleaved for {@link budget} ms and print a table. */
export const runGroups = async (title: string, groups: ReadonlyArray<Group>): Promise<void> => {
  console.log(`\n# ${title}\n`);
  for (const group of groups) {
    if (!group.name.includes(filter)) continue;
    const samples = group.cases.map((): Array<number> => []);
    // warm-up: every case a few times
    for (let i = 0; i < 3; i++) for (const c of group.cases) await time(c.run);
    const deadline = performance.now() + budget;
    let rounds = 0;
    while (rounds < 15 || (performance.now() < deadline && rounds < 1000)) {
      for (let i = 0; i < group.cases.length; i++)
        samples[i]!.push(await time(group.cases[i]!.run));
      rounds++;
    }
    const medians = samples.map(median);
    const fastest = Math.min(...medians);
    const mb = group.bytes / 1e6;
    console.log(`## ${group.name} (${mb.toFixed(2)} MB, ${rounds} rounds)\n`);
    console.log(
      `| ${pad("case", 34)} | ${padL("median ms", 10)} | ${padL("best ms", 9)} | ${padL("MB/s", 8)} | ${padL("vs fastest", 10)} |`,
    );
    console.log(
      `| ${"-".repeat(34)} | ${"-".repeat(9)}: | ${"-".repeat(8)}: | ${"-".repeat(7)}: | ${"-".repeat(9)}: |`,
    );
    group.cases.forEach((c, i) => {
      const m = medians[i]!;
      console.log(
        `| ${pad(c.name, 34)} | ${padL(m.toFixed(2), 10)} | ${padL(Math.min(...samples[i]!).toFixed(2), 9)} | ${padL((mb / (m / 1000)).toFixed(1), 8)} | ${padL(`${(m / fastest).toFixed(2)}x`, 10)} |`,
      );
    });
    console.log("");
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
