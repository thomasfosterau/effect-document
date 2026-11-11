/**
 * Recognising CSV and TSV content for `detect` (#188), on a bounded sample:
 * text without NUL bytes whose lines split into the same number of fields by
 * the separator. Separators inside quotes are not counted.
 */

import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import type { Content, Sniff, Sniffer } from "../index.ts";

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
