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

// oxlint-disable-next-line effect/use-command-executor-service -- the harness is plain Node, no Effect runtime around the timing (see above); a child per case is spawned between timings
import { spawnSync } from "node:child_process";
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
 * Time one block of a case: a few warm-up runs (the first block only), then
 * samples for at least `minRounds` runs and until `budget` ms have passed (at
 * most 1000). Each block runs one case on its own, not interleaved run by run
 * with the others: interleaved, a case is charged for the collections the
 * garbage of the case before it brings on, which penalises whichever
 * allocates most.
 */
const sampleCase = async (
  c: Case,
  minRounds: number,
  caseBudget: number,
  warm: boolean,
): Promise<Array<number>> => {
  if (warm) for (let i = 0; i < 3; i++) await time(c.run);
  const samples: Array<number> = [];
  const deadline = performance.now() + caseBudget;
  while (samples.length < minRounds || (performance.now() < deadline && samples.length < 1000))
    samples.push(await time(c.run));
  sink = undefined;
  return samples;
};

/**
 * How many blocks each case is sampled in (`BENCH_BLOCKS`, default 5). A
 * machine's speed drifts over a run (a shared VM's by a third or more), and
 * a case sampled in one block takes whatever speed its block ran at: in
 * several short blocks, the cases taking turns (in reverse order every other
 * round, so none always follows the same one), every case meets the drift
 * alike.
 */
const blocks = Math.max(1, Number(process.env["BENCH_BLOCKS"] ?? 5));

/** Every case's samples, the group's time shared between them. */
const sampleGroup = async (
  cases: ReadonlyArray<Case>,
  minRounds: number,
  groupBudget = budget,
): Promise<Array<Array<number>>> => {
  const out: Array<Array<number>> = cases.map(() => []);
  const perBlock = Math.ceil(minRounds / blocks);
  for (let round = 0; round < blocks; round++) {
    const order = round % 2 === 0 ? cases.keys() : [...cases.keys()].toReversed();
    for (const i of order) {
      const c = cases[i]!;
      out[i]!.push(
        ...(await sampleCase(c, perBlock, groupBudget / cases.length / blocks, round === 0)),
      );
    }
  }
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

/**
 * Whether each case runs in a process of its own (`BENCH_ISOLATE`, on unless
 * `0`). In one process, a case's speed depends on the cases before it: the
 * type feedback they left on code they share with it (every configuration of
 * a reader runs the same scanner), and the garbage they left in the old
 * generation, both of which this harness measured as a third of a CSV read's
 * time. A fresh process per case is how an application meets one library.
 */
const isolate = process.env["BENCH_ISOLATE"] !== "0";
/** In a child process: the group (among the filtered ones) and case it runs, as `group:case`. */
const child = process.env["BENCH_CHILD"];
/** The prefix of the line a child reports its results on. */
const RESULT = "BENCH_RESULT ";

/** One case's results, as a child process reports them. */
interface CaseResult {
  readonly samples: ReadonlyArray<number>;
  /** The bytes its result holds, or -1 where they cannot be measured (JSON holds no `undefined`). */
  readonly heap: number;
}

/** Run case `index` of a group in a process of its own, sampled for its share of the group's time. */
const runIsolated = (groupIndex: number, index: number, cases: number): CaseResult => {
  const result = spawnSync(process.execPath, [...process.execArgv, process.argv[1] ?? ""], {
    env: { ...process.env, BENCH_CHILD: `${groupIndex}:${index}`, BENCH_SHARE: String(cases) },
    encoding: "utf8",
    maxBuffer: 1 << 26,
  });
  const line = result.stdout.split("\n").find((l) => l.startsWith(RESULT));
  if (line === undefined)
    // oxlint-disable-next-line effect/avoid-untagged-errors -- a failed benchmark run ends the script: plain Node, no Effect runtime here
    throw new Error(`benchmark case ${groupIndex}:${index} failed:\n${result.stderr}`);
  // oxlint-disable-next-line effect/avoid-direct-json, typescript/no-unsafe-type-assertion, effect/casting-awareness, effect/require-safety-comment-for-type-assertion -- SAFETY: the line is the child's own `JSON.stringify` of a CaseResult, below
  return JSON.parse(line.slice(RESULT.length)) as CaseResult;
};

/** In a child process: run its one case and report it on stdout. */
const runChild = async (groups: ReadonlyArray<GroupSource>, which: string): Promise<void> => {
  const [g, c] = which.split(":").map(Number);
  const source = groups[g ?? 0];
  const group = source === undefined ? undefined : build(source);
  const one = group?.cases[c ?? 0];
  // oxlint-disable-next-line effect/avoid-untagged-errors -- as above
  if (group === undefined || one === undefined) throw new Error(`no benchmark case ${which}`);
  const share = Number(process.env["BENCH_SHARE"] ?? 1);
  const [samples = []] = await sampleGroup([one], group.minRounds ?? 15, budget / share);
  const [heap] = await memory([one]);
  // oxlint-disable-next-line effect/avoid-direct-json -- the report to the parent process, read back above
  console.log(RESULT + JSON.stringify({ samples, heap: heap ?? -1 }));
};

/** Run each group's cases for {@link budget} ms, each in its own process (see {@link isolate}), and print a table. */
export const runGroups = async (
  title: string,
  groups: ReadonlyArray<GroupSource>,
): Promise<void> => {
  const chosen = groups.filter((g) => g.name.includes(filter));
  if (child !== undefined) return runChild(chosen, child);
  console.log(`\n# ${title}\n`);
  for (const [groupIndex, source] of chosen.entries()) {
    const group = build(source);
    if (isolate) {
      const results = group.cases.map((_, i) => runIsolated(groupIndex, i, group.cases.length));
      printTable(
        group,
        results.map((r) => r.samples),
        results.map((r) => (r.heap < 0 ? undefined : r.heap)),
      );
    } else {
      const samples = await sampleGroup(group.cases, group.minRounds ?? 15);
      printTable(group, samples, await memory(group.cases));
    }
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
