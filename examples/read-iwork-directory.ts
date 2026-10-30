/**
 * Reading an iWork document saved as a directory (a `.key`, `.pages` or
 * `.numbers` folder bundle) with the Keynote, Pages and Numbers readers.
 *
 * The readers take `Content` bytes: a zipped package. A folder bundle is opened
 * with the codec's `openBundleDirectory` instead, which reads only the `.iwa`
 * components through the `FileSystem` service, under the same zip-bomb limits
 * and the same password-protection check as the readers. Its components are
 * then packed into an in-memory zip (stored, not compressed) and handed to the
 * reader like any other `.key` file.
 *
 * The example first unpacks the vendored `simple-oneslide.key` fixture into a
 * temporary directory, so there is a folder bundle to read.
 *
 * Run with: vp exec tsx examples/read-iwork-directory.ts (after `vp run -r build`)
 */

import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as R from "effect/Record";
import { zipSync, unzipSync } from "fflate";
import { blocksToText, bytes, type Content } from "@thomasfosterau/effect-document";
import { type BundleLimits, openBundleDirectory } from "@thomasfosterau/effect-iwork/codec";
import * as Keynote from "@thomasfosterau/effect-iwork/keynote";

/**
 * Open a folder bundle and repackage its components as the zipped `Content`
 * every iWork reader takes. Only the components are read (and so zipped): the
 * readers use nothing else.
 */
const directoryContent = (path: string, limits?: BundleLimits) =>
  Effect.map(openBundleDirectory(path, { limits }), (bundle): Content =>
    bytes(zipSync(bundle.components, { level: 0 })),
  );

/** Write a zipped package out as a folder bundle, entry by entry. */
const unpackTo = Effect.fn("unpackTo")(function* (zipped: Uint8Array, dir: string) {
  const fs = yield* FileSystem.FileSystem;
  // a name ending in "/" is a directory entry, created with its first file
  const files = R.toEntries(unzipSync(zipped)).filter(([name]) => !name.endsWith("/"));
  yield* Effect.forEach(
    files,
    ([name, data]) => {
      const target = `${dir}/${name}`;
      return fs
        .makeDirectory(target.slice(0, target.lastIndexOf("/")), { recursive: true })
        .pipe(Effect.andThen(fs.writeFile(target, data)));
    },
    { concurrency: 1, discard: true },
  );
});

const program = Effect.fn("readIworkDirectory")(function* () {
  const fs = yield* FileSystem.FileSystem;

  // --- Make a folder bundle from the zipped fixture ----------------------
  const zipped = yield* fs.readFile("packages/iwork/test/fixtures/simple-oneslide.key");
  const tmp = yield* fs.makeTempDirectoryScoped();
  const deck = `${tmp}/simple-oneslide.key`;
  yield* unpackTo(zipped, deck);

  // --- Open the folder and read it with the Keynote reader ---------------
  // The same composition works for `Pages.makePagesReader()` and
  // `Numbers.makeNumbersReader()`; pass the same limits to both steps.
  const limits: BundleLimits = { maxTotalSize: 64 * 1024 * 1024 };
  const input = yield* directoryContent(deck, limits);
  const doc = yield* Keynote.makeKeynoteReader({ limits }).read(input);

  yield* Console.log(`Read ${deck.slice(tmp.length + 1)} from a directory:`);
  yield* Console.log(blocksToText(doc.blocks));
});

await Effect.runPromise(program().pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)));
