/**
 * Reading the vendored fixtures under `test/fixtures` (provenance:
 * `test/fixtures/ATTRIBUTION.md`) through the `FileSystem` service.
 */

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { assert } from "vite-plus/test";

const readFixture = (name: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const data = yield* fs.readFile(
      yield* path.fromFileUrl(new URL(`./fixtures/${name}`, import.meta.url)),
    );
    return [name, data] as const;
  });

/**
 * Read the named fixtures up front (a suite's `await` at module level) and
 * return a synchronous lookup, which fails the test for a name not loaded.
 */
export const loadFixtures = async (
  names: ReadonlyArray<string>,
): Promise<(name: string) => Uint8Array> => {
  const files = new Map(
    await Effect.runPromise(
      Effect.forEach(names, readFixture, { concurrency: "unbounded" }).pipe(
        Effect.provide(NodeServices.layer),
      ),
    ),
  );
  return (name) => {
    const data = files.get(name);
    assert(data !== undefined, `fixture ${name} was not loaded`);
    return data;
  };
};
