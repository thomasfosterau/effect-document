import { describe, expect, test } from "vite-plus/test";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { bytes, contentToText, convert } from "@thomasfosterau/effect-document";
import { Keynote } from "@thomasfosterau/effect-iwork";
import * as Rtf from "@thomasfosterau/effect-rtf";

/** Reads one of the iWork package's binary fixtures. */
const fixture = Effect.fn("fixture")(function* (name: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const file = yield* path.fromFileUrl(
    new URL(`../../packages/iwork/test/fixtures/${name}`, import.meta.url),
  );
  return yield* fs.readFile(file);
});

describe("convert: Keynote -> RTF (iWork into a writable format)", () => {
  test("flattens the deck's text into RTF", async () => {
    const { content } = await Effect.runPromise(
      fixture("simple-oneslide.key").pipe(
        Effect.flatMap((data) =>
          convert({ from: Keynote.format, to: Rtf.format, input: bytes(data) }),
        ),
        Effect.provide(NodeServices.layer),
      ),
    );
    const rtf = contentToText(content);
    expect(rtf.startsWith("{\\rtf1")).toBe(true);
    expect(rtf).toContain("Example Presentation");
  });
});
