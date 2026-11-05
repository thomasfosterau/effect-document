/**
 * The iWork readers (Numbers, Keynote) on the package's test fixtures.
 * JavaScript has no other iWork reader to measure against, and iWork can
 * only be written by Apple's apps, so these are this package's own numbers:
 * the throughput to watch across changes. The fixtures are small, so this
 * mostly measures the fixed cost of opening a bundle (ZIP, Snappy, the
 * protobuf archive index).
 *
 * Run with `vp run bench:iwork` (builds first).
 */
import { readFileSync } from "node:fs";
import { bytes } from "@thomasfosterau/effect-document";
import { Keynote, Numbers } from "@thomasfosterau/effect-iwork";
import * as Effect from "effect/Effect";
import { type Group, runGroups } from "./harness.ts";

const run = <A, E>(effect: Effect.Effect<A, E>): A => Effect.runSync(effect);
const fixture = (name: string): Uint8Array =>
  new Uint8Array(readFileSync(new URL(`../packages/iwork/test/fixtures/${name}`, import.meta.url)));

const numbers = fixture("test-1.numbers");
const keynote = fixture("simple-oneslide.key");
const numbersReader = Numbers.makeNumbersReader();
const keynoteReader = Keynote.makeKeynoteReader();

const groups: Array<Group> = [
  {
    name: "read: test-1.numbers (fixture)",
    bytes: numbers.length,
    cases: [
      { name: "effect-iwork Numbers read", run: () => run(numbersReader.read(bytes(numbers))) },
    ],
  },
  {
    name: "read: simple-oneslide.key (fixture)",
    bytes: keynote.length,
    cases: [
      { name: "effect-iwork Keynote read", run: () => run(keynoteReader.read(bytes(keynote))) },
    ],
  },
];

await runGroups("iWork", groups);
