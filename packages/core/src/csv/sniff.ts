/**
 * Recognising CSV and TSV content for `detect` (#188), on a bounded sample:
 * text without NUL bytes whose lines split into the same number of fields by
 * the separator. Separators inside quotes are not counted.
 */

import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Effect from "effect/Effect";
import type { Content, Sniff, Sniffer } from "../index.ts";
import type { CsvDialect } from "./dialect.ts";
import { readCsvRows } from "./reader.ts";

/** How much of the input the sniffers look at: the first 64 KiB. */
export const SNIFF_SAMPLE_BYTES = 64 * 1024;
/** How many lines of the sample they compare. */
const SAMPLE_LINES = 50;

/** The sample as text, or undefined when it holds a NUL byte (binary). */
const sampleText = (content: Content): string | undefined => {
  if (Predicate.isTagged(content, "Text")) return content.text.slice(0, SNIFF_SAMPLE_BYTES);
  const bytes = content.bytes.subarray(0, SNIFF_SAMPLE_BYTES);
  if (bytes.includes(0)) return undefined;
  return new TextDecoder("utf-8").decode(bytes);
};

/** The fields each sampled line splits into by `separator`, outside double quotes. */
const fieldCounts = (sample: string, separator: string): ReadonlyArray<number> => {
  const counts: Array<number> = [];
  let fields = 1;
  let quoted = false;
  let empty = true;
  for (const ch of sample) {
    if (counts.length >= SAMPLE_LINES) break;
    if (ch === '"') quoted = !quoted;
    else if (!quoted && ch === separator) fields += 1;
    else if (!quoted && (ch === "\n" || ch === "\r")) {
      if (!empty) counts.push(fields);
      fields = 1;
      empty = true;
      continue;
    }
    empty = false;
  }
  if (!empty && counts.length < SAMPLE_LINES) counts.push(fields);
  return counts;
};

/** A sniffer for text separated by `separator`, called `name` in its evidence. */
const delimited =
  (separator: string, name: string): Sniffer =>
  (content) => {
    const sample = sampleText(content);
    if (sample === undefined) return Option.none();
    const counts = fieldCounts(sample, separator);
    if (Arr.isReadonlyArrayEmpty(counts)) return Option.none();
    const widest = Math.max(...counts);
    if (widest < 2) {
      // one column: still a table, but the weakest guess
      return Option.some<Sniff>({ confidence: 0.1, evidence: `text with no ${name}` });
    }
    const consistent = counts.filter((c) => c === counts[0]).length / counts.length;
    const lines = counts.length;
    // the more lines agree, the surer; a single line is a weak guess
    const confidence = lines === 1 ? 0.4 : consistent === 1 ? 0.85 : consistent >= 0.8 ? 0.6 : 0.3;
    return Option.some<Sniff>({
      confidence,
      evidence: `${lines} line(s), ${Math.round(consistent * 100)}% with ${counts[0]} ${name}-separated fields`,
    });
  };

/** The CSV sniffer: text whose lines split into the same number of comma-separated fields. */
export const sniffCsv: Sniffer = delimited(",", "comma");
/** The TSV sniffer: text whose lines split into the same number of tab-separated fields. */
export const sniffTsv: Sniffer = delimited("\t", "tab");

/** The separators {@link sniffDialect} tries, in order of preference on a tie. */
export const SNIFF_SEPARATORS: ReadonlyArray<string> = [",", ";", "\t", "|"];
/** How many leading lines {@link sniffDialect} will call a preamble (`skipRows`). */
const MAX_PREAMBLE = 10;

/** What {@link sniffDialect} found: reader options for the dialect, how sure it is, and why. */
export interface SniffedDialect {
  /**
   * The reader options the sample implies: the dialect (separator, wrapper,
   * line break), the preamble lines to skip, and whether the first row read
   * is a header (the reader's own rule, #88, applied to the sample).
   */
  readonly options: {
    readonly dialect: CsvDialect;
    readonly skipRows: number;
    readonly treatFirstRowAsHeader: boolean;
  };
  /** How sure the sniff is, from 0 to 1: the share of sampled lines that agree on the field count. */
  readonly confidence: number;
  /** A short reason a UI can show. */
  readonly evidence: string;
}

/** The line break used most in `sample`: CRLF, LF or a bare CR. */
const lineBreakOf = (sample: string): string => {
  const crlf = sample.split("\r\n").length - 1;
  const cr = sample.split("\r").length - 1 - crlf;
  const lf = sample.split("\n").length - 1 - crlf;
  return crlf >= lf && crlf >= cr && crlf > 0 ? "\r\n" : cr > lf ? "\r" : "\n";
};

/** The sample up to its last line break, so a line cut off by the sample's end isn't judged. */
const wholeLines = (sample: string, complete: boolean): string => {
  if (complete) return sample;
  const last = Math.max(sample.lastIndexOf("\n"), sample.lastIndexOf("\r"));
  return last < 0 ? sample : sample.slice(0, last + 1);
};

/** The most common value in `counts`, and how many lines hold it. */
const modeOf = (
  counts: ReadonlyArray<number>,
): { readonly value: number; readonly lines: number } =>
  counts.reduce(
    (best, c) => {
      const lines = counts.filter((x) => x === c).length;
      return lines > best.lines || (lines === best.lines && c > best.value)
        ? { value: c, lines }
        : best;
    },
    { value: 1, lines: 0 },
  );

/**
 * The CSV dialect a bounded sample of text follows (#188): its separator (of
 * {@link SNIFF_SEPARATORS}), its line break, how many preamble lines come
 * before the table, and whether the table's first row is a header. A field
 * wrapped in double quotes may hold separators and line breaks. Only the
 * first {@link SNIFF_SAMPLE_BYTES} are looked at, and a line the sample cuts
 * off isn't judged, so the sniff agrees with a scan of the whole file.
 * `Option.none` when the sample has no separator that splits most lines.
 *
 * ```ts
 * const sniffed = yield* sniffDialect(text);
 * // Option.some({ options: { dialect: { separator: ";", … }, skipRows: 0, treatFirstRowAsHeader: true }, … })
 * ```
 */
export const sniffDialect = (input: string): Effect.Effect<Option.Option<SniffedDialect>> =>
  Effect.gen(function* () {
    const complete = input.length <= SNIFF_SAMPLE_BYTES;
    const sample = wholeLines(input.slice(0, SNIFF_SAMPLE_BYTES), complete);
    const scored = SNIFF_SEPARATORS.map((separator) => {
      const counts = fieldCounts(sample, separator);
      const mode = modeOf(counts);
      // a preamble: the leading lines before the first one with the table's width
      const first = counts.findIndex((c) => c === mode.value);
      const skipRows = first > 0 && first <= MAX_PREAMBLE ? first : 0;
      const table = counts.slice(skipRows);
      const consistency = Arr.isReadonlyArrayEmpty(table)
        ? 0
        : table.filter((c) => c === mode.value).length / table.length;
      return { separator, width: mode.value, skipRows, consistency, lines: table.length };
    }).filter((s) => s.width >= 2);
    const best = scored.reduce<(typeof scored)[number] | undefined>(
      (b, s) =>
        b === undefined ||
        s.consistency > b.consistency ||
        (s.consistency === b.consistency && s.width > b.width)
          ? s
          : b,
      undefined,
    );
    if (best === undefined) return Option.none();
    const dialect: CsvDialect = {
      separator: best.separator,
      linebreak: lineBreakOf(sample),
      wrapper: '"',
      doubleWrapper: '""',
    };
    // the reader's own header rule, on the sample: what a full read would decide
    const rows = yield* Effect.option(readCsvRows(sample, { dialect, skipRows: best.skipRows }));
    const treatFirstRowAsHeader = Option.exists(rows, (r) => r.headers !== null);
    const name = best.separator === "\t" ? "tab" : `"${best.separator}"`;
    return Option.some({
      options: { dialect, skipRows: best.skipRows, treatFirstRowAsHeader },
      confidence: Math.min(0.95, best.consistency),
      evidence:
        `${best.lines} line(s), ${Math.round(best.consistency * 100)}% with ${best.width} ${name}-separated fields` +
        (best.skipRows > 0 ? `, after ${best.skipRows} preamble line(s)` : "") +
        (treatFirstRowAsHeader ? ", header row" : ""),
    });
  });
