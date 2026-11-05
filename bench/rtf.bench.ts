/**
 * The RTF reader and writer, on prose documents of headings, styled
 * paragraphs, lists and tables (`prose.ts`). JavaScript has no maintained
 * RTF library to measure against, so the numbers are this package's own:
 * the throughput to watch across changes.
 *
 * Run with `vp run bench:rtf` (builds first).
 */
import { contentToText, narrow, text } from "@thomasfosterau/effect-document";
import { makeRtfReader, makeRtfWriter, Rtf } from "@thomasfosterau/effect-rtf";
import * as Effect from "effect/Effect";
import { type Group, runGroups } from "./harness.ts";
import { proseDocument } from "./prose.ts";

const run = <A, E>(effect: Effect.Effect<A, E>): A => Effect.runSync(effect);
const reader = makeRtfReader();
const writer = makeRtfWriter();

const groups = (name: string, sections: number): Array<Group> => {
  const doc = narrow(proseDocument(sections), Rtf).document;
  const written = run(writer.write(doc));
  const source = contentToText(written);
  const size = new TextEncoder().encode(source).length;
  return [
    {
      name: `read: ${name}`,
      bytes: size,
      cases: [{ name: "effect-rtf read", run: () => run(reader.read(text(source))) }],
    },
    {
      name: `write: ${name}`,
      bytes: size,
      cases: [{ name: "effect-rtf write (document)", run: () => run(writer.write(doc)) }],
    },
  ];
};

await runGroups("RTF", [...groups("500 sections", 500), ...groups("20 sections", 20)]);
