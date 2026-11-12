/**
 * Reading the vendored fixtures under `test/fixtures` (provenance:
 * `test/fixtures/ATTRIBUTION.md`) through the `FileSystem` service, so a test
 * runs under `layer(NodeServices.layer)` and reads the fixtures it needs.
 */

import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

/** The path of a vendored fixture. */
const fixturePath = (name: string) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    return yield* path.fromFileUrl(new URL(`./fixtures/${name}`, import.meta.url));
  });

/** The bytes of the named vendored fixture, read through the `FileSystem` service. */
export const fixture = (name: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return yield* fs.readFile(yield* fixturePath(name));
  });

/**
 * The real `FileSystem.File.Info` of a vendored fixture, so a stubbed `stat`
 * can spread it rather than spell every field: the field types differ across
 * the effect versions the peer range admits (`dev` is a `number` on 4.0.x and
 * a `bigint` from 4.1).
 */
export const statFixture = (name: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return yield* fs.stat(yield* fixturePath(name));
  });
