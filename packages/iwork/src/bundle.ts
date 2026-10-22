/**
 * Opening an iWork bundle.
 *
 * A `.pages`/`.numbers`/`.key` is a zip whose serialized object graph lives in
 * `Index/*.iwa` components (older documents pack these into an inner `Index.zip`).
 * Media lives in `Data/`, light metadata in `Metadata/`. Password-protected
 * documents carry a top-level `.iwph` marker and are refused.
 *
 * Only the components are inflated: media and previews are listed and read on
 * demand with `readEntry`. Entry counts and declared sizes are checked before
 * anything is inflated (fflate never inflates past an entry's declared size),
 * so a zip bomb fails with `LimitExceeded` instead of exhausting memory. A
 * package saved as a directory (a `.key` folder) is opened with
 * {@link openBundleDirectory}.
 */

import { Effect, FileSystem, Result } from "effect";
import { unzipSync } from "fflate";
import { decodeIwa, type IworkObject } from "./archive.js";
import { codecError, IworkError, isIworkError, withLocation } from "./errors.js";
import type { DechunkOptions } from "./iwa.js";

export interface IworkBundle {
  /** Component path (e.g. "Index/Document.iwa") -> raw `.iwa` bytes. */
  readonly components: Record<string, Uint8Array>;
  /** Every path in the package, including the entries not inflated (`Data/`, previews). */
  readonly entries: ReadonlyArray<string>;
  /** Read one entry of the package on demand (e.g. a `Data/` media file), under the entry size limit. */
  readonly readEntry: (path: string) => Effect.Effect<Uint8Array, IworkError>;
}

export interface BundleLimits {
  /** The most entries the package (and an inner `Index.zip`) may list. Defaults to 10,000. */
  readonly maxEntries?: number;
  /** The largest uncompressed size of any one entry read. Defaults to 256 MiB. */
  readonly maxEntrySize?: number;
  /** The most uncompressed bytes inflated for the components, in total. Defaults to 512 MiB. */
  readonly maxTotalSize?: number;
}

export interface OpenBundleOptions {
  readonly limits?: BundleLimits;
}

/** The default {@link BundleLimits}. */
export const DEFAULT_BUNDLE_LIMITS: Required<BundleLimits> = {
  maxEntries: 10_000,
  maxEntrySize: 256 * 1024 * 1024,
  maxTotalSize: 512 * 1024 * 1024,
};

const ENCRYPTED_MARKER = ".iwph";

const isIndexZip = (name: string): boolean => name.toLowerCase().endsWith("index.zip");
const isComponent = (name: string): boolean => name.endsWith(".iwa");

/** The size accounting shared by the outer package and an inner `Index.zip`. */
interface Budget {
  readonly limits: Required<BundleLimits>;
  total: number;
}

/** Charge one entry's uncompressed size to the budget, or fail. */
const charge = (budget: Budget, name: string, size: number): void => {
  const { maxEntrySize, maxTotalSize } = budget.limits;
  if (size > maxEntrySize) {
    throw codecError("LimitExceeded", `${name} is ${size} bytes uncompressed, over the ${maxEntrySize}-byte limit`);
  }
  budget.total += size;
  if (budget.total > maxTotalSize) {
    throw codecError("LimitExceeded", `the components exceed the ${maxTotalSize}-byte total limit`);
  }
};

/**
 * Unzip only the entries `want` accepts, checking the entry count and (for the
 * wanted entries) the declared sizes before inflating. Returns every name seen.
 * Throws an `IworkError`.
 */
const unzip = (
  bytes: Uint8Array,
  budget: Budget,
  want: (name: string, size: number) => boolean
): { readonly names: string[]; readonly files: Record<string, Uint8Array> } => {
  const names: string[] = [];
  try {
    const files = unzipSync(bytes, {
      filter: ({ name, originalSize }) => {
        if (names.length >= budget.limits.maxEntries) {
          throw codecError("LimitExceeded", `more than ${budget.limits.maxEntries} zip entries`);
        }
        names.push(name);
        return want(name, originalSize);
      },
    });
    return { names, files };
  } catch (e) {
    if (isIworkError(e)) throw e;
    // fflate's error 13 is "invalid zip data": no end-of-central-directory record
    const notZip = (e as { code?: number }).code === 13;
    throw new IworkError({
      reason: notZip ? "NotZip" : "Malformed",
      detail: notZip ? "not a zip archive" : `bad zip entry: ${e instanceof Error ? e.message : String(e)}`,
      cause: e,
    });
  }
};

/** Collect the `.iwa` components of an inner `Index.zip`. */
const innerComponents = (data: Uint8Array, budget: Budget, into: Record<string, Uint8Array>): void => {
  const { files } = unzip(data, budget, (name, size) => {
    if (!isComponent(name)) return false;
    charge(budget, `Index.zip/${name}`, size);
    return true;
  });
  for (const [inner, innerData] of Object.entries(files)) {
    into[inner.startsWith("Index/") ? inner : `Index/${inner}`] = innerData;
  }
};

const resolveLimits = (options?: OpenBundleOptions): Required<BundleLimits> => ({
  ...DEFAULT_BUNDLE_LIMITS,
  ...options?.limits,
});

/**
 * Open an iWork bundle, inflating only its `.iwa` components. Fails with an
 * `IworkError`: `NotZip`, `Encrypted`, `LimitExceeded` or `Malformed`.
 */
export const openBundle = (
  bytes: Uint8Array,
  options?: OpenBundleOptions
): Result.Result<IworkBundle, IworkError> => {
  const limits = resolveLimits(options);
  try {
    const budget: Budget = { limits, total: 0 };
    const { names, files } = unzip(bytes, budget, (name, size) => {
      if (name === ENCRYPTED_MARKER) {
        throw codecError("Encrypted", "encrypted (password-protected) iWork documents are not supported");
      }
      if (!isComponent(name) && !isIndexZip(name)) return false;
      charge(budget, name, size);
      return true;
    });
    const components: Record<string, Uint8Array> = {};
    for (const [name, data] of Object.entries(files)) {
      // older single-file documents nest the components in an inner Index.zip
      if (isIndexZip(name)) innerComponents(data, budget, components);
      else components[name] = data;
    }
    const readEntry = (path: string): Effect.Effect<Uint8Array, IworkError> =>
      Effect.suspend(() => {
        try {
          // a fresh budget per read: in effect, only the entry-size limit applies
          const budget: Budget = { limits, total: 0 };
          const { files } = unzip(bytes, budget, (name, size) => {
            if (name !== path) return false;
            charge(budget, name, size);
            return true;
          });
          const data = files[path];
          return data === undefined
            ? Effect.fail(codecError("Io", `no entry ${path} in the package`))
            : Effect.succeed(data);
        } catch (e) {
          return Effect.fail(e as IworkError);
        }
      });
    return Result.succeed({ components, entries: names, readEntry });
  } catch (e) {
    return Result.fail(e as IworkError);
  }
};

/**
 * Open an iWork package saved as a directory (e.g. a `.key` folder bundle),
 * reading only its `.iwa` components (or inner `Index.zip`) through the
 * `FileSystem` service, under the same limits as {@link openBundle}.
 */
export const openBundleDirectory = (
  path: string,
  options?: OpenBundleOptions
): Effect.Effect<IworkBundle, IworkError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const limits = resolveLimits(options);
    const root = path.replace(/[\\/]+$/, "");
    const join = (name: string) => `${root}/${name}`;
    const io = (cause: { readonly message: string }) =>
      new IworkError({ reason: "Io", detail: cause.message, cause });

    /** Read one file, after checking its size against the entry limit. */
    const readChecked = (name: string, budget: Budget) =>
      Effect.gen(function* () {
        const info = yield* fs.stat(join(name)).pipe(Effect.mapError(io));
        yield* Effect.try({ try: () => charge(budget, name, Number(info.size)), catch: (e) => e as IworkError });
        return yield* fs.readFile(join(name)).pipe(Effect.mapError(io));
      });

    // recursive listings use the platform separator
    const names = (yield* fs.readDirectory(root, { recursive: true }).pipe(Effect.mapError(io))).map((n) =>
      n.replaceAll("\\", "/")
    );
    if (names.length > limits.maxEntries) {
      return yield* Effect.fail(codecError("LimitExceeded", `more than ${limits.maxEntries} package entries`));
    }
    if (names.includes(ENCRYPTED_MARKER)) {
      return yield* Effect.fail(
        codecError("Encrypted", "encrypted (password-protected) iWork documents are not supported")
      );
    }
    const budget: Budget = { limits, total: 0 };
    const components: Record<string, Uint8Array> = {};
    for (const name of names) {
      if (!isComponent(name) && !isIndexZip(name)) continue;
      const data = yield* readChecked(name, budget);
      if (isIndexZip(name)) {
        yield* Effect.try({
          try: () => innerComponents(data, budget, components),
          catch: (e) => withLocation(e as IworkError, { component: name }),
        });
      } else {
        components[name] = data;
      }
    }
    const readEntry = (entry: string) => readChecked(entry, { limits, total: 0 });
    return { components, entries: names, readEntry };
  });

/** The component paths matching a predicate (e.g. slides), in sorted order. */
export const componentPaths = (
  bundle: IworkBundle,
  match: (name: string) => boolean
): string[] => Object.keys(bundle.components).filter(match).sort();

/**
 * Decode a single component's archived objects (none if it is absent). A
 * failure carries the component path.
 */
export const decodeComponent = (
  bundle: IworkBundle,
  name: string,
  options?: DechunkOptions
): Result.Result<IworkObject[], IworkError> => {
  const data = bundle.components[name];
  if (data === undefined) return Result.succeed([]);
  return Result.mapError(decodeIwa(data, options), (e) => withLocation(e, { component: name }));
};

/**
 * Decode every component's objects, flattened (a whole-document object scan).
 * Fails on the first bad component.
 */
export const decodeAll = (
  bundle: IworkBundle,
  options?: DechunkOptions
): Result.Result<IworkObject[], IworkError> => {
  const objects: IworkObject[] = [];
  for (const name of Object.keys(bundle.components)) {
    const decoded = decodeComponent(bundle, name, options);
    if (Result.isFailure(decoded)) return decoded;
    for (const obj of decoded.success) objects.push(obj);
  }
  return Result.succeed(objects);
};
