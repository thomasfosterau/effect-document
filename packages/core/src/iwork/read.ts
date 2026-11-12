/**
 * What the Pages, Numbers and Keynote readers share: opening the bundle,
 * walking components object by object, and turning an `IworkError` into the
 * reader's `ParseError` without losing where it happened.
 */

import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import {
  type Content,
  contentToBytes,
  logDiagnostic,
  ParseError,
  type ParseErrorCode,
  type SourcePosition,
} from "../index.ts";
import type { IworkObject } from "./archive.ts";
import { type BundleLimits, decodeComponent, type IworkBundle, openBundle } from "./bundle.ts";
import { type IworkError, type IworkErrorReason, isIworkError, withLocation } from "./errors.ts";
import { readPackageMetadata } from "./metadata.ts";

/** Options shared by the Pages, Numbers and Keynote readers. */
export interface IworkReaderOptions {
  /**
   * Skip a component that fails to decode instead of failing the whole read,
   * reporting it as an `iwork.componentSkipped` diagnostic (#112: a warning
   * log record that `convert` collects into its report). Defaults to false.
   */
  readonly lenient?: boolean | undefined;
  /** Zip-bomb limits for opening the bundle (see `BundleLimits`). */
  readonly limits?: BundleLimits | undefined;
}

/** The `ParseError` code of each codec failure (#127); an I/O failure has none. */
const IWORK_CODE = {
  NotZip: "InvalidContainer",
  NotIwork: "WrongFormat",
  LegacyIwork09Unsupported: "Unsupported",
  Encrypted: "Encrypted",
  LimitExceeded: "LimitExceeded",
  Truncated: "MalformedBinary",
  Malformed: "MalformedBinary",
  Io: undefined,
} as const satisfies Record<IworkErrorReason, ParseErrorCode | undefined>;

/** Where a codec failure happened, as a `ParseError` position (undefined when unknown). */
const iworkPosition = (e: IworkError): SourcePosition | undefined =>
  e.component === undefined && e.objectId === undefined && e.offset === undefined
    ? undefined
    : {
        component: e.component,
        object: e.objectId === undefined ? undefined : String(e.objectId),
        offset: e.offset,
      };

/**
 * An `IworkError` as a reader's `ParseError`; the message names the component,
 * object and offset. A `LimitExceeded` error (a zip or Snappy bomb) keeps its
 * class in `code`, as the OOXML readers' limit failures do.
 */
/** An `IworkError` as the `ParseError` a reader fails with, its cause kept. */
export const toParseError = (format: string, e: IworkError): ParseError =>
  new ParseError({
    format,
    reason: `Failed to read ${format}: ${e.reason}: ${e.message}`,
    code: IWORK_CODE[e.reason],
    position: iworkPosition(e),
    cause: e,
  });

/** Open the input as an iWork bundle. */
export const openInput = (
  format: string,
  input: Content,
  options?: IworkReaderOptions,
): Effect.Effect<IworkBundle, ParseError> =>
  Effect.suspend(() =>
    Effect.fromResult(
      Result.mapError(
        openBundle(
          contentToBytes(input),
          options?.limits === undefined ? undefined : { limits: options.limits },
        ),
        (e) => toParseError(format, e),
      ),
    ),
  );

/** The three iWork readers' formats. */
type IworkFormat = "keynote" | "pages" | "numbers";

/** A range of `fileFormatVersion` major versions, inclusive. */
interface VersionRange {
  readonly min: number;
  readonly max: number;
}

/**
 * The `fileFormatVersion` majors each reader is known to read (#101, owner
 * decision: a provisional range now). Provisional: they are the majors of the
 * documents it has been run on, the vendored fixtures and the corpora
 * (`corpora.json`), and widen as more are. Numbers' version follows the app's
 * (11.0.3 to 26.4.0 across numbers-parser's test files, all read); Keynote's
 * fixture is 3.2.13. Pages has no document to check against yet, so it has no
 * range and is not checked.
 */
const KNOWN_FORMAT_VERSIONS = {
  keynote: Option.some({ min: 3, max: 3 }),
  numbers: Option.some({ min: 11, max: 26 }),
  pages: Option.none(),
} satisfies Record<IworkFormat, Option.Option<VersionRange>>;

/** The major version of a dotted `fileFormatVersion` (`"11.0.3"` is 11), if it has one. */
const majorOf = (version: string): Option.Option<number> => {
  const major = Number.parseInt(version, 10);
  return Number.isSafeInteger(major) ? Option.some(major) : Option.none();
};

/**
 * Report, as an `iwork.unknownFormatVersion` diagnostic (a `notice`: nothing
 * is lost), a document whose `fileFormatVersion` major is outside the range
 * {@link KNOWN_FORMAT_VERSIONS} gives its format; the read goes on either way,
 * since the message layouts it reads seldom change between versions. Nothing
 * is reported for a format without a range, a package without metadata or a
 * version, or metadata that fails to decode (the reader does not need it, and
 * a reader that does, through the resolver, reports that itself).
 */
export const reportFormatVersion = (
  format: IworkFormat,
  bundle: IworkBundle,
): Effect.Effect<void> =>
  Effect.suspend(() => {
    const range: Option.Option<VersionRange> = KNOWN_FORMAT_VERSIONS[format];
    const metadata = readPackageMetadata(bundle);
    if (Option.isNone(range) || Result.isFailure(metadata)) return Effect.void;
    const known = range.value;
    const version = Option.map(metadata.success, (m) => m.fileFormatVersion);
    return Option.match(Option.flatMap(version, majorOf), {
      onNone: () => Effect.void,
      onSome: (major) =>
        major >= known.min && major <= known.max
          ? Effect.void
          : logDiagnostic({
              format,
              stage: "read",
              code: "iwork.unknownFormatVersion",
              severity: "notice",
              path: [],
              detail: `fileFormatVersion ${Option.getOrElse(version, () => "")} is outside the versions this reader is known to read (majors ${known.min} to ${known.max}); reading it anyway`,
            }),
    });
  });

/**
 * Decode each named component and `visit` its objects in order, collecting
 * what the visitor returns per component. A failure (in the codec or the
 * visitor) carries the component and object; in lenient mode that component
 * is skipped with a warning and left out of the result.
 */
export const eachComponent = <A>(
  format: string,
  bundle: IworkBundle,
  names: ReadonlyArray<string>,
  options: IworkReaderOptions | undefined,
  visit: (obj: IworkObject) => ReadonlyArray<A>,
): Effect.Effect<Array<ComponentItems<A>>, ParseError> =>
  Effect.forEach(
    names,
    (name): Effect.Effect<ReadonlyArray<ComponentItems<A>>, ParseError> => {
      const result = visitComponent(bundle, name, visit);
      if (Result.isSuccess(result)) return Effect.succeed([{ name, items: result.success }]);
      if (options?.lenient === true)
        return Effect.as(
          logDiagnostic({
            format,
            stage: "read",
            code: "iwork.componentSkipped",
            severity: "dropped-content",
            path: [name],
            detail: `skipping component ${name}, which failed to decode: ${result.failure.message}`,
          }),
          [],
        );
      return Effect.fail(toParseError(format, result.failure));
    },
    { concurrency: 1 },
  ).pipe(Effect.map(Arr.flatten));

/** One component's visited items, from {@link eachComponent}. */
export interface ComponentItems<A> {
  readonly name: string;
  readonly items: A[];
}

const visitComponent = <A>(
  bundle: IworkBundle,
  name: string,
  visit: (obj: IworkObject) => ReadonlyArray<A>,
): Result.Result<A[], IworkError> => {
  const decoded = decodeComponent(bundle, name);
  if (Result.isFailure(decoded)) return Result.fail(decoded.failure);
  const items: A[] = [];
  for (const obj of decoded.success) {
    const visited = Result.try({ try: () => visit(obj), catch: (e) => e });
    if (Result.isFailure(visited)) {
      // only codec failures are expected here; anything else is a bug (a defect)
      if (!isIworkError(visited.failure)) throw visited.failure;
      return Result.fail(
        withLocation(visited.failure, { component: name, objectId: obj.identifier }),
      );
    }
    for (const item of visited.success) items.push(item);
  }
  return Result.succeed(items);
};
