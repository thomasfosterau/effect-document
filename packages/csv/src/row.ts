/**
 * A finished CSV row, copied out of the scan's scratch array by an array
 * literal of its width.
 *
 * V8 allocates an array literal at an allocation site, which learns how long
 * what it allocates lives: a site whose arrays outlive the young generation
 * (a reader's rows, kept until the table is done) is pretenured, its arrays
 * allocated straight into the old generation, so no scavenge copies them.
 * An array made by `slice`, `Array.from`, a spread or `new Array` has no
 * site, and every row is copied once or twice before it is promoted: on
 * bench/csv.bench.ts's floats table, three times the scavenges and a third
 * of the reader's time. A literal per width, as uDSV's generated row
 * converters are, earns the site; a row wider than {@link MAX_LITERAL_WIDTH}
 * is sliced.
 *
 * Rows of numbers have a table of their own: a site also learns its arrays'
 * elements kind, and one that has made a row holding text makes every later
 * row generic, each number boxed. Copied by {@link DOUBLE_ROWS}, a row of
 * numbers stays an array of unboxed doubles.
 *
 * @internal
 */

/** The widest row copied by a literal. */
export const MAX_LITERAL_WIDTH = 32;

/** A scratch array, typed as holding at least {@link MAX_LITERAL_WIDTH} values. */
// oxfmt-ignore
type Fixed<T> = readonly [T, T, T, T, T, T, T, T, T, T, T, T, T, T, T, T, T, T, T, T, T, T, T, T, T, T, T, T, T, T, T, T, ...Array<T>];

/** A copy of a row's first `n` values, `n` being the copier's index plus one. */
type Copy = <T>(s: Fixed<T>) => Array<T>;

/** Copiers by width, for rows of any values. */
// oxfmt-ignore
const ROWS: ReadonlyArray<Copy> = [
  (s) => [s[0]],
  (s) => [s[0], s[1]],
  (s) => [s[0], s[1], s[2]],
  (s) => [s[0], s[1], s[2], s[3]],
  (s) => [s[0], s[1], s[2], s[3], s[4]],
  (s) => [s[0], s[1], s[2], s[3], s[4], s[5]],
  (s) => [s[0], s[1], s[2], s[3], s[4], s[5], s[6]],
  (s) => [s[0], s[1], s[2], s[3], s[4], s[5], s[6], s[7]],
  (s) => [s[0], s[1], s[2], s[3], s[4], s[5], s[6], s[7], s[8]],
  (s) => [s[0], s[1], s[2], s[3], s[4], s[5], s[6], s[7], s[8], s[9]],
  (s) => [s[0], s[1], s[2], s[3], s[4], s[5], s[6], s[7], s[8], s[9], s[10]],
  (s) => [s[0], s[1], s[2], s[3], s[4], s[5], s[6], s[7], s[8], s[9], s[10], s[11]],
  (s) => [s[0], s[1], s[2], s[3], s[4], s[5], s[6], s[7], s[8], s[9], s[10], s[11], s[12]],
  (s) => [s[0], s[1], s[2], s[3], s[4], s[5], s[6], s[7], s[8], s[9], s[10], s[11], s[12], s[13]],
  (s) => [s[0], s[1], s[2], s[3], s[4], s[5], s[6], s[7], s[8], s[9], s[10], s[11], s[12], s[13], s[14]],
  (s) => [s[0], s[1], s[2], s[3], s[4], s[5], s[6], s[7], s[8], s[9], s[10], s[11], s[12], s[13], s[14], s[15]],
  (s) => [s[0], s[1], s[2], s[3], s[4], s[5], s[6], s[7], s[8], s[9], s[10], s[11], s[12], s[13], s[14], s[15], s[16]],
  (s) => [s[0], s[1], s[2], s[3], s[4], s[5], s[6], s[7], s[8], s[9], s[10], s[11], s[12], s[13], s[14], s[15], s[16], s[17]],
  (s) => [s[0], s[1], s[2], s[3], s[4], s[5], s[6], s[7], s[8], s[9], s[10], s[11], s[12], s[13], s[14], s[15], s[16], s[17], s[18]],
  (s) => [s[0], s[1], s[2], s[3], s[4], s[5], s[6], s[7], s[8], s[9], s[10], s[11], s[12], s[13], s[14], s[15], s[16], s[17], s[18], s[19]],
  (s) => [s[0], s[1], s[2], s[3], s[4], s[5], s[6], s[7], s[8], s[9], s[10], s[11], s[12], s[13], s[14], s[15], s[16], s[17], s[18], s[19], s[20]],
  (s) => [s[0], s[1], s[2], s[3], s[4], s[5], s[6], s[7], s[8], s[9], s[10], s[11], s[12], s[13], s[14], s[15], s[16], s[17], s[18], s[19], s[20], s[21]],
  (s) => [s[0], s[1], s[2], s[3], s[4], s[5], s[6], s[7], s[8], s[9], s[10], s[11], s[12], s[13], s[14], s[15], s[16], s[17], s[18], s[19], s[20], s[21], s[22]],
  (s) => [s[0], s[1], s[2], s[3], s[4], s[5], s[6], s[7], s[8], s[9], s[10], s[11], s[12], s[13], s[14], s[15], s[16], s[17], s[18], s[19], s[20], s[21], s[22], s[23]],
  (s) => [s[0], s[1], s[2], s[3], s[4], s[5], s[6], s[7], s[8], s[9], s[10], s[11], s[12], s[13], s[14], s[15], s[16], s[17], s[18], s[19], s[20], s[21], s[22], s[23], s[24]],
  (s) => [s[0], s[1], s[2], s[3], s[4], s[5], s[6], s[7], s[8], s[9], s[10], s[11], s[12], s[13], s[14], s[15], s[16], s[17], s[18], s[19], s[20], s[21], s[22], s[23], s[24], s[25]],
  (s) => [s[0], s[1], s[2], s[3], s[4], s[5], s[6], s[7], s[8], s[9], s[10], s[11], s[12], s[13], s[14], s[15], s[16], s[17], s[18], s[19], s[20], s[21], s[22], s[23], s[24], s[25], s[26]],
  (s) => [s[0], s[1], s[2], s[3], s[4], s[5], s[6], s[7], s[8], s[9], s[10], s[11], s[12], s[13], s[14], s[15], s[16], s[17], s[18], s[19], s[20], s[21], s[22], s[23], s[24], s[25], s[26], s[27]],
  (s) => [s[0], s[1], s[2], s[3], s[4], s[5], s[6], s[7], s[8], s[9], s[10], s[11], s[12], s[13], s[14], s[15], s[16], s[17], s[18], s[19], s[20], s[21], s[22], s[23], s[24], s[25], s[26], s[27], s[28]],
  (s) => [s[0], s[1], s[2], s[3], s[4], s[5], s[6], s[7], s[8], s[9], s[10], s[11], s[12], s[13], s[14], s[15], s[16], s[17], s[18], s[19], s[20], s[21], s[22], s[23], s[24], s[25], s[26], s[27], s[28], s[29]],
  (s) => [s[0], s[1], s[2], s[3], s[4], s[5], s[6], s[7], s[8], s[9], s[10], s[11], s[12], s[13], s[14], s[15], s[16], s[17], s[18], s[19], s[20], s[21], s[22], s[23], s[24], s[25], s[26], s[27], s[28], s[29], s[30]],
  (s) => [s[0], s[1], s[2], s[3], s[4], s[5], s[6], s[7], s[8], s[9], s[10], s[11], s[12], s[13], s[14], s[15], s[16], s[17], s[18], s[19], s[20], s[21], s[22], s[23], s[24], s[25], s[26], s[27], s[28], s[29], s[30], s[31]],
];

/** Copiers by width for rows of numbers only, each its own allocation site (see the module comment). */
// the same source as ROWS on purpose: each literal is an allocation site of its own
// oxfmt-ignore
// fallow-ignore-next-line code-duplication
const DOUBLE_ROWS: ReadonlyArray<Copy> = [
  (s) => [s[0]],
  (s) => [s[0], s[1]],
  (s) => [s[0], s[1], s[2]],
  (s) => [s[0], s[1], s[2], s[3]],
  (s) => [s[0], s[1], s[2], s[3], s[4]],
  (s) => [s[0], s[1], s[2], s[3], s[4], s[5]],
  (s) => [s[0], s[1], s[2], s[3], s[4], s[5], s[6]],
  (s) => [s[0], s[1], s[2], s[3], s[4], s[5], s[6], s[7]],
  (s) => [s[0], s[1], s[2], s[3], s[4], s[5], s[6], s[7], s[8]],
  (s) => [s[0], s[1], s[2], s[3], s[4], s[5], s[6], s[7], s[8], s[9]],
  (s) => [s[0], s[1], s[2], s[3], s[4], s[5], s[6], s[7], s[8], s[9], s[10]],
  (s) => [s[0], s[1], s[2], s[3], s[4], s[5], s[6], s[7], s[8], s[9], s[10], s[11]],
  (s) => [s[0], s[1], s[2], s[3], s[4], s[5], s[6], s[7], s[8], s[9], s[10], s[11], s[12]],
  (s) => [s[0], s[1], s[2], s[3], s[4], s[5], s[6], s[7], s[8], s[9], s[10], s[11], s[12], s[13]],
  (s) => [s[0], s[1], s[2], s[3], s[4], s[5], s[6], s[7], s[8], s[9], s[10], s[11], s[12], s[13], s[14]],
  (s) => [s[0], s[1], s[2], s[3], s[4], s[5], s[6], s[7], s[8], s[9], s[10], s[11], s[12], s[13], s[14], s[15]],
  (s) => [s[0], s[1], s[2], s[3], s[4], s[5], s[6], s[7], s[8], s[9], s[10], s[11], s[12], s[13], s[14], s[15], s[16]],
  (s) => [s[0], s[1], s[2], s[3], s[4], s[5], s[6], s[7], s[8], s[9], s[10], s[11], s[12], s[13], s[14], s[15], s[16], s[17]],
  (s) => [s[0], s[1], s[2], s[3], s[4], s[5], s[6], s[7], s[8], s[9], s[10], s[11], s[12], s[13], s[14], s[15], s[16], s[17], s[18]],
  (s) => [s[0], s[1], s[2], s[3], s[4], s[5], s[6], s[7], s[8], s[9], s[10], s[11], s[12], s[13], s[14], s[15], s[16], s[17], s[18], s[19]],
  (s) => [s[0], s[1], s[2], s[3], s[4], s[5], s[6], s[7], s[8], s[9], s[10], s[11], s[12], s[13], s[14], s[15], s[16], s[17], s[18], s[19], s[20]],
  (s) => [s[0], s[1], s[2], s[3], s[4], s[5], s[6], s[7], s[8], s[9], s[10], s[11], s[12], s[13], s[14], s[15], s[16], s[17], s[18], s[19], s[20], s[21]],
  (s) => [s[0], s[1], s[2], s[3], s[4], s[5], s[6], s[7], s[8], s[9], s[10], s[11], s[12], s[13], s[14], s[15], s[16], s[17], s[18], s[19], s[20], s[21], s[22]],
  (s) => [s[0], s[1], s[2], s[3], s[4], s[5], s[6], s[7], s[8], s[9], s[10], s[11], s[12], s[13], s[14], s[15], s[16], s[17], s[18], s[19], s[20], s[21], s[22], s[23]],
  (s) => [s[0], s[1], s[2], s[3], s[4], s[5], s[6], s[7], s[8], s[9], s[10], s[11], s[12], s[13], s[14], s[15], s[16], s[17], s[18], s[19], s[20], s[21], s[22], s[23], s[24]],
  (s) => [s[0], s[1], s[2], s[3], s[4], s[5], s[6], s[7], s[8], s[9], s[10], s[11], s[12], s[13], s[14], s[15], s[16], s[17], s[18], s[19], s[20], s[21], s[22], s[23], s[24], s[25]],
  (s) => [s[0], s[1], s[2], s[3], s[4], s[5], s[6], s[7], s[8], s[9], s[10], s[11], s[12], s[13], s[14], s[15], s[16], s[17], s[18], s[19], s[20], s[21], s[22], s[23], s[24], s[25], s[26]],
  (s) => [s[0], s[1], s[2], s[3], s[4], s[5], s[6], s[7], s[8], s[9], s[10], s[11], s[12], s[13], s[14], s[15], s[16], s[17], s[18], s[19], s[20], s[21], s[22], s[23], s[24], s[25], s[26], s[27]],
  (s) => [s[0], s[1], s[2], s[3], s[4], s[5], s[6], s[7], s[8], s[9], s[10], s[11], s[12], s[13], s[14], s[15], s[16], s[17], s[18], s[19], s[20], s[21], s[22], s[23], s[24], s[25], s[26], s[27], s[28]],
  (s) => [s[0], s[1], s[2], s[3], s[4], s[5], s[6], s[7], s[8], s[9], s[10], s[11], s[12], s[13], s[14], s[15], s[16], s[17], s[18], s[19], s[20], s[21], s[22], s[23], s[24], s[25], s[26], s[27], s[28], s[29]],
  (s) => [s[0], s[1], s[2], s[3], s[4], s[5], s[6], s[7], s[8], s[9], s[10], s[11], s[12], s[13], s[14], s[15], s[16], s[17], s[18], s[19], s[20], s[21], s[22], s[23], s[24], s[25], s[26], s[27], s[28], s[29], s[30]],
  (s) => [s[0], s[1], s[2], s[3], s[4], s[5], s[6], s[7], s[8], s[9], s[10], s[11], s[12], s[13], s[14], s[15], s[16], s[17], s[18], s[19], s[20], s[21], s[22], s[23], s[24], s[25], s[26], s[27], s[28], s[29], s[30], s[31]],
];

/**
 * The first `n` values of `scratch` as a new array: by a literal of width
 * `n` (from the table for rows of numbers when `numbers` is set), or a slice
 * when `n` is wider than {@link MAX_LITERAL_WIDTH} or zero.
 */
export const copyRow = <T>(scratch: Array<T>, n: number, numbers: boolean): Array<T> => {
  const copy = (numbers ? DOUBLE_ROWS : ROWS)[n - 1];
  if (copy === undefined) return scratch.slice(0, n);
  // SAFETY: a copier of width n reads indices below n only, and the scratch holds n values
  // oxlint-disable-next-line effect/no-chained-type-assertions, effect/avoid-any, typescript/no-unsafe-type-assertion, effect/casting-awareness, effect/require-safety-comment-for-type-assertion -- SAFETY: as above (a tuple type is how the copiers index without `!`)
  return copy(scratch as unknown as Fixed<T>);
};
