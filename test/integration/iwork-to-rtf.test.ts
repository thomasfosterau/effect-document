import { describe, expect, test } from "vite-plus/test";
import { readFileSync } from "node:fs";
import { Effect } from "effect";
import { bytes, contentToText, convert } from "@thomasfosterau/effect-document";
import { Keynote } from "@thomasfosterau/effect-iwork";
import * as Rtf from "@thomasfosterau/effect-rtf";

const run = <A, E>(e: Effect.Effect<A, E>): A => Effect.runSync(e);
const fixture = (name: string): Uint8Array =>
  new Uint8Array(readFileSync(new URL(`../../packages/iwork/test/fixtures/${name}`, import.meta.url)));

describe("convert: Keynote -> RTF (iWork into a writable format)", () => {
  test("flattens the deck's text into RTF", () => {
    const { content } = run(
      convert({ from: Keynote.format, to: Rtf.format, input: bytes(fixture("simple-oneslide.key")) })
    );
    const rtf = contentToText(content);
    expect(rtf.startsWith("{\\rtf1")).toBe(true);
    expect(rtf).toContain("Example Presentation");
  });
});
