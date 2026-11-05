/**
 * Seeded prose documents for the word-processing benchmarks (DOCX, RTF,
 * PDF): sections of a heading, paragraphs mixing plain, bold and italic
 * runs, a bullet list and a small table, repeated to the size asked for.
 */
import {
  bulletList,
  document,
  type Document,
  emph,
  header,
  para,
  plainText,
  str,
  strong,
  table,
} from "@thomasfosterau/effect-document";
import { rng } from "./harness.ts";

const words = (
  "lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor " +
  "incididunt ut labore et dolore magna aliqua enim ad minim veniam quis nostrud"
).split(" ");

/** Seeded words and sentences: the same sequence on every run. */
const writer = () => {
  const random = rng(2026);
  const word = () => words[Math.floor(random() * words.length)] ?? "";
  const sentence = (n: number) => Array.from({ length: n }, word).join(" ");
  return { word, sentence };
};

/** A document of `sections` sections, the same for every run. */
export const proseDocument = (sections: number): Document => {
  const { word, sentence } = writer();
  return document(
    Array.from({ length: sections }, (_section, s) => [
      header(2, [str(`Section ${s + 1}: ${sentence(3)}`)]),
      ...Array.from({ length: 4 }, () =>
        para([
          str(`${sentence(12)} `),
          strong([str(sentence(3))]),
          str(` ${sentence(10)} `),
          emph([str(sentence(2))]),
          str(` ${sentence(15)}.`),
        ]),
      ),
      bulletList(Array.from({ length: 3 }, () => [plainText(sentence(6))])),
      table({
        headers: ["Name", "Value", "Note"],
        rows: Array.from({ length: 4 }, (_, r) => [
          [plainText(word())],
          [plainText(String(r * s))],
          [plainText(sentence(3))],
        ]),
      }),
    ]).flat(),
  );
};

/** The text of {@link proseDocument}'s paragraphs, for libraries that take plain strings. */
export const proseParagraphs = (sections: number): Array<string> => {
  const { sentence } = writer();
  return Array.from(
    { length: sections * 4 },
    () => `${sentence(12)} ${sentence(3)} ${sentence(10)} ${sentence(2)} ${sentence(15)}.`,
  );
};
