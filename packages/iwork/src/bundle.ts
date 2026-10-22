/**
 * Opening an iWork bundle.
 *
 * A `.pages`/`.numbers`/`.key` is a zip whose serialized object graph lives in
 * `Index/*.iwa` components (older documents pack these into an inner `Index.zip`).
 * Media lives in `Data/`, light metadata in `Metadata/`. Password-protected
 * documents carry a top-level `.iwph` marker and are refused, and so is a zip
 * with no components: an iWork '09 package (XML in `index.apxl`/`index.xml`)
 * or something else entirely (e.g. a `.docx`).
 *
 * Only the components are inflated: media and previews are listed and read on
 * demand with `readEntry`. Entry counts and declared sizes are checked before
 * anything is inflated (fflate never inflates past an entry's declared size),
 * so a zip bomb fails with `LimitExceeded` instead of exhausting memory. A
 * package saved as a directory (a `.key` folder) is opened with
 * {@link openBundleDirectory}.
 */

import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Order from "effect/Order";
import type { Ordering } from "effect/Ordering";
import * as Predicate from "effect/Predicate";
import * as Result from "effect/Result";
import { unzipSync } from "fflate";
import { decodeIwa, type IworkObject } from "./archive.ts";
import {
  codecError,
  describeCause,
  IworkError,
  isIworkError,
  rethrowing,
  toIworkError,
  withLocation,
} from "./errors.ts";
import type { DechunkOptions } from "./iwa.ts";

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
  readonly maxEntries?: number | undefined;
  /** The largest uncompressed size of any one entry read. Defaults to 256 MiB. */
  readonly maxEntrySize?: number | undefined;
  /** The most uncompressed bytes inflated for the components, in total. Defaults to 512 MiB. */
  readonly maxTotalSize?: number | undefined;
}

export interface OpenBundleOptions {
  readonly limits?: BundleLimits | undefined;
}

/** The default {@link BundleLimits}. */
export const DEFAULT_BUNDLE_LIMITS: ResolvedLimits = {
  maxEntries: 10_000,
  maxEntrySize: 256 * 1024 * 1024,
  maxTotalSize: 512 * 1024 * 1024,
};

const ENCRYPTED_MARKER = ".iwph";

/** The root document of an iWork '09 package: Keynote's `index.apxl`, Pages' and Numbers' `index.xml`. */
const LEGACY_INDEX = /^index\.(?:apxl|xml)(?:\.gz)?$/i;

/** Why a package with no components can't be read. */
const noComponents = (names: ReadonlyArray<string>): IworkError =>
  names.some((name) => LEGACY_INDEX.test(name))
    ? codecError("LegacyIwork09Unsupported", "iWork '09 (XML) documents are not supported yet")
    : codecError("NotIwork", "not an iWork document: the package has no Index/*.iwa components");

const isIndexZip = (name: string): boolean => name.toLowerCase().endsWith("index.zip");
const isComponent = (name: string): boolean => name.endsWith(".iwa");

/** `BundleLimits` with every limit filled in. */
type ResolvedLimits = { readonly [K in keyof BundleLimits]-?: NonNullable<BundleLimits[K]> };

/** The size accounting shared by the outer package and an inner `Index.zip`. */
interface Budget {
  readonly limits: ResolvedLimits;
  total: number;
}

/** Charge one entry's uncompressed size to the budget, or fail. */
const charge = (budget: Budget, name: string, size: number): void => {
  const { maxEntrySize, maxTotalSize } = budget.limits;
  if (size > maxEntrySize) {
    throw codecError(
      "LimitExceeded",
      `${name} is ${size} bytes uncompressed, over the ${maxEntrySize}-byte limit`,
    );
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
  want: (name: string, size: number) => boolean,
): Unzipped => {
  const names: string[] = [];
  const files = rethrowing(
    () =>
      unzipSync(bytes, {
        filter: ({ name, originalSize }) => {
          if (names.length >= budget.limits.maxEntries) {
            throw codecError("LimitExceeded", `more than ${budget.limits.maxEntries} zip entries`);
          }
          names.push(name);
          return want(name, originalSize);
        },
      }),
    (e) => {
      if (isIworkError(e)) return e;
      // fflate's error 13 is "invalid zip data": no end-of-central-directory record
      const notZip = Predicate.hasProperty(e, "code") && e.code === 13;
      return new IworkError({
        reason: notZip ? "NotZip" : "Malformed",
        detail: notZip ? "not a zip archive" : `bad zip entry: ${describeCause(e)}`,
        cause: e,
      });
    },
  );
  return { names, files };
};

/** What {@link unzip} returns: every entry name seen, and the inflated entries it wanted. */
interface Unzipped {
  readonly names: string[];
  readonly files: Record<string, Uint8Array>;
}

/** Collect the `.iwa` components of an inner `Index.zip`. */
const innerComponents = (
  data: Uint8Array,
  budget: Budget,
  into: Record<string, Uint8Array>,
): void => {
  const { files } = unzip(data, budget, (name, size) => {
    if (!isComponent(name)) return false;
    charge(budget, `Index.zip/${name}`, size);
    return true;
  });
  for (const [inner, innerData] of Object.entries(files)) {
    into[inner.startsWith("Index/") ? inner : `Index/${inner}`] = innerData;
  }
};

const resolveLimits = (options?: OpenBundleOptions): ResolvedLimits => {
  // an explicitly `undefined` limit keeps its default
  const limits = options?.limits;
  return {
    maxEntries: limits?.maxEntries ?? DEFAULT_BUNDLE_LIMITS.maxEntries,
    maxEntrySize: limits?.maxEntrySize ?? DEFAULT_BUNDLE_LIMITS.maxEntrySize,
    maxTotalSize: limits?.maxTotalSize ?? DEFAULT_BUNDLE_LIMITS.maxTotalSize,
  };
};

/**
 * Open an iWork bundle, inflating only its `.iwa` components. Fails with an
 * `IworkError`: `NotZip`, `Encrypted`, `LimitExceeded` or `Malformed`.
 */
export const openBundle = (
  bytes: Uint8Array,
  options?: OpenBundleOptions,
): Result.Result<IworkBundle, IworkError> => {
  const limits = resolveLimits(options);
  return Result.try({
    try: (): IworkBundle => {
      const budget: Budget = { limits, total: 0 };
      const { names, files } = unzip(bytes, budget, (name, size) => {
        if (name === ENCRYPTED_MARKER) {
          throw codecError(
            "Encrypted",
            "encrypted (password-protected) iWork documents are not supported",
          );
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
      if (Arr.isReadonlyArrayEmpty(Object.keys(components))) throw noComponents(names);
      const readEntry = (path: string): Effect.Effect<Uint8Array, IworkError> =>
        Effect.try({
          try: () => {
            // a fresh budget per read: in effect, only the entry-size limit applies
            const budget: Budget = { limits, total: 0 };
            const { files } = unzip(bytes, budget, (name, size) => {
              if (name !== path) return false;
              charge(budget, name, size);
              return true;
            });
            return files[path];
          },
          catch: toIworkError,
        }).pipe(
          Effect.flatMap((data) =>
            data === undefined
              ? Effect.fail(codecError("Io", `no entry ${path} in the package`))
              : Effect.succeed(data),
          ),
        );
      return { components, entries: names, readEntry };
    },
    catch: toIworkError,
  });
};

/**
 * Open an iWork package saved as a directory (e.g. a `.key` folder bundle),
 * reading only its `.iwa` components (or inner `Index.zip`) through the
 * `FileSystem` service, under the same limits as {@link openBundle}.
 */
export const openBundleDirectory = (
  path: string,
  options?: OpenBundleOptions,
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
        yield* Effect.try({
          try: () => charge(budget, name, Number(info.size)),
          catch: toIworkError,
        });
        return yield* fs.readFile(join(name)).pipe(Effect.mapError(io));
      });

    // recursive listings use the platform separator
    const names = (yield* fs
      .readDirectory(root, { recursive: true })
      .pipe(Effect.mapError(io))).map((n) => n.replaceAll("\\", "/"));
    if (names.length > limits.maxEntries) {
      return yield* Effect.fail(
        codecError("LimitExceeded", `more than ${limits.maxEntries} package entries`),
      );
    }
    if (names.includes(ENCRYPTED_MARKER)) {
      return yield* Effect.fail(
        codecError("Encrypted", "encrypted (password-protected) iWork documents are not supported"),
      );
    }
    const budget: Budget = { limits, total: 0 };
    const components: Record<string, Uint8Array> = {};
    yield* Effect.forEach(
      names.filter((name) => isComponent(name) || isIndexZip(name)),
      (name) =>
        Effect.flatMap(readChecked(name, budget), (data) =>
          Effect.try({
            try: () => {
              if (isIndexZip(name)) innerComponents(data, budget, components);
              else components[name] = data;
            },
            catch: (e) => withLocation(toIworkError(e), { component: name }),
          }),
        ),
      { concurrency: 1, discard: true },
    );
    if (Arr.isReadonlyArrayEmpty(Object.keys(components)))
      return yield* Effect.fail(noComponents(names));
    const readEntry = (entry: string) => readChecked(entry, { limits, total: 0 });
    return { components, entries: names, readEntry };
  });

const EXTENSION = /\.[^./]*$/;

/**
 * Compare paths with their digit runs as numbers, so `Slide-8060.iwa` sorts
 * before `Slide-10000.iwa` and `Slide-8060.iwa` before `Slide-8060-2.iwa`.
 */
export const compareComponentPaths = (a: string, b: string): Ordering => {
  // compare the stems, so a path that ends (".iwa") sorts before one that goes on ("-2.iwa")
  const as = a.replace(EXTENSION, "").split(/(\d+)/);
  const bs = b.replace(EXTENSION, "").split(/(\d+)/);
  for (let i = 0; i < Math.min(as.length, bs.length); i++) {
    // split() puts the digit runs at odd indexes
    const order = i % 2 === 1 ? DigitRunOrder(as[i]!, bs[i]!) : Order.String(as[i]!, bs[i]!);
    if (order !== 0) return order;
  }
  return as.length !== bs.length ? Order.Number(as.length, bs.length) : Order.String(a, b);
};

/** Digit runs by value: without leading zeros, the shorter run is the smaller number. */
const DigitRunOrder: Order.Order<string> = Order.mapInput(
  Order.combine(
    Order.mapInput(Order.Number, (digits: string) => digits.length),
    Order.String,
  ),
  (run: string) => run.replace(/^0+/, ""),
);

/** Component paths in natural order, as an `Order` (see {@link compareComponentPaths}). */
export const ComponentPathOrder: Order.Order<string> = Order.make(compareComponentPaths);

/**
 * The component paths matching a predicate (e.g. slides), in natural order
 * (see {@link compareComponentPaths}). Component ids are not document order:
 * that comes from the document's object graph.
 */
export const componentPaths = (bundle: IworkBundle, match: (name: string) => boolean): string[] =>
  Arr.sort(Object.keys(bundle.components).filter(match), ComponentPathOrder);

/**
 * Decode a single component's archived objects (none if it is absent). A
 * failure carries the component path.
 */
export const decodeComponent = (
  bundle: IworkBundle,
  name: string,
  options?: DechunkOptions,
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
  options?: DechunkOptions,
): Result.Result<IworkObject[], IworkError> => {
  const objects: IworkObject[] = [];
  for (const name of Object.keys(bundle.components)) {
    const decoded = decodeComponent(bundle, name, options);
    if (Result.isFailure(decoded)) return decoded;
    for (const obj of decoded.success) objects.push(obj);
  }
  return Result.succeed(objects);
};
