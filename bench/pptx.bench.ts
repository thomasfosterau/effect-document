/**
 * The PPTX reader and writer, on decks of slides with a title box and a
 * bulleted body box. JavaScript has no widely used PPTX reader, so the
 * reader is measured on its own; the writer is measured against PptxGenJS,
 * the most used PPTX writer, writing the same text.
 *
 * Run with `vp run bench:pptx` (builds first).
 */
import {
  bulletList,
  bytes,
  contentToBytes,
  document,
  para,
  plainText,
  slide,
  slideShow,
  str,
  strong,
  textBox,
  trustAs,
} from "@thomasfosterau/effect-document";
import { Pptx } from "@thomasfosterau/effect-ooxml";
import * as Effect from "effect/Effect";
import PptxGenJS from "pptxgenjs";
import { type Group, rng, runGroups } from "./harness.ts";

const run = <A, E>(effect: Effect.Effect<A, E>): A => Effect.runSync(effect);
const reader = Pptx.makePptxReader();
const writer = Pptx.makePptxWriter();

const words = "agenda results growth plan risk team market revenue quarter launch".split(" ");

const deck = (slides: number) => {
  const random = rng(2026);
  const word = () => words[Math.floor(random() * words.length)] ?? "";
  const line = () => Array.from({ length: 8 }, word).join(" ");
  return Array.from({ length: slides }, (_, i) => ({
    title: `Slide ${i + 1}: ${word()} ${word()}`,
    bullets: Array.from({ length: 5 }, line),
  }));
};

const groups = (name: string, slides: number): Array<Group> => {
  const content = deck(slides);
  const doc = trustAs<Pptx.PptxFeature>(
    document([
      slideShow(
        content.map(({ title, bullets }) =>
          slide([
            textBox([para([strong([str(title)])])]),
            textBox([bulletList(bullets.map((b) => [plainText(b)]))]),
          ]),
        ),
      ),
    ]),
  );
  const written = run(writer.write(doc));
  const file = contentToBytes(written);
  const pptxgen = () => {
    const pres = new PptxGenJS();
    for (const { title, bullets } of content) {
      const s = pres.addSlide();
      s.addText(title, { x: 0.5, y: 0.3, w: 9, h: 1, bold: true });
      s.addText(
        bullets.map((text) => ({ text, options: { bullet: true, breakLine: true } })),
        { x: 0.5, y: 1.5, w: 9, h: 4 },
      );
    }
    return pres.write({ outputType: "uint8array" });
  };
  return [
    {
      name: `read: ${name}`,
      bytes: file.length,
      cases: [{ name: "effect-ooxml read", run: () => run(reader.read(bytes(file))) }],
    },
    {
      name: `write: ${name}`,
      bytes: file.length,
      cases: [
        { name: "effect-ooxml write (document)", run: () => run(writer.write(doc)) },
        { name: "PptxGenJS write", run: pptxgen },
      ],
    },
  ];
};

await runGroups("PPTX", [...groups("200 slides", 200), ...groups("10 slides", 10)]);
