/**
 * The package metadata (#101): `Index/Metadata.iwa`'s `TSP.PackageMetadata`,
 * which lists the document's components (with the objects they refer to in
 * other components) and its data files (`Data/`), so objects can be found
 * across components and an image's bytes from its data id.
 *
 * Field numbers are from keynote-parser's `TSPArchiveMessages.proto` (MIT;
 * `protos/versions/14.4`, the same in 10.2 and 14.5 for every field read here),
 * checked against the vendored Keynote and Numbers fixtures.
 */

import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import type { IworkObject } from "./archive.ts";
import { decodeComponent, type IworkBundle } from "./bundle.ts";
import type { DechunkOptions } from "./iwa.ts";
import { codecError, type IworkError, toIworkError, withLocation } from "./errors.ts";
import {
  decodeUtf8,
  type Field,
  getAllBytes,
  getBigInt,
  getBytes,
  getPacked,
  getVarint,
  parseMessage,
} from "./protobuf.ts";
import { TSP_PACKAGE_METADATA } from "./registry.ts";
import { FIELDS } from "./schema.generated.ts";

/** The component holding the package metadata. */
export const METADATA_COMPONENT = "Index/Metadata.iwa";

/** A reference from one component to an object in another (`TSP.ComponentExternalReference`). */
export interface ComponentReference {
  /** The component the object lives in. */
  readonly component: bigint;
  /** The object, when the reference names one rather than the component's root. */
  readonly object: Option.Option<bigint>;
  /** Whether the reference is weak (the object may be absent). */
  readonly weak: boolean;
}

/** One component of the package (`TSP.ComponentInfo`). */
export interface ComponentInfo {
  /** The component's identifier: the identifier of its root object. */
  readonly identifier: bigint;
  /** Its path in the package, e.g. `Index/MasterSlide-7915.iwa`. */
  readonly path: string;
  /** The objects in other components that it refers to. */
  readonly externalReferences: ReadonlyArray<ComponentReference>;
  /** The data files (`Data/`) it refers to, by data identifier. */
  readonly dataReferences: ReadonlyArray<bigint>;
}

/** One data file of the package (`TSP.DataInfo`): an image, a movie, a font. */
export interface DataInfo {
  /** The identifier objects refer to it by. */
  readonly identifier: bigint;
  /** The name the app would give it, e.g. `photo.jpeg`. */
  readonly preferredFileName: string;
  /**
   * Where it is stored in this package, e.g. `Data/photo-12.jpeg`. `None` for
   * data the app supplies itself (a theme's stock images), which the package
   * does not hold.
   */
  readonly path: Option.Option<string>;
}

/** What a document's `Index/Metadata.iwa` says about its package (`TSP.PackageMetadata`). */
export interface PackageMetadata {
  /** The file format version, e.g. `"11.0.3"` (as `Metadata/Properties.plist`'s `fileFormatVersion`). */
  readonly fileFormatVersion: string;
  /** The oldest app version that can read the document, e.g. `[2, 4, 0]`. */
  readonly readVersion: ReadonlyArray<number>;
  /** Every component, in the order the metadata lists them. */
  readonly components: ReadonlyArray<ComponentInfo>;
  /** Every data file. */
  readonly datas: ReadonlyArray<DataInfo>;
}

/** Field numbers of the `TSP` messages read here, from the generated schema. */
const PACKAGE = FIELDS["TSP.PackageMetadata"];
const COMPONENT = FIELDS["TSP.ComponentInfo"];
const EXTERNAL = FIELDS["TSP.ComponentExternalReference"];
const DATA_REFERENCE = FIELDS["TSP.ComponentDataReference"];
const DATA = FIELDS["TSP.DataInfo"];
const PACKAGE_COMPONENTS = PACKAGE.components;
const PACKAGE_DATAS = PACKAGE.datas;
const PACKAGE_READ_VERSION = PACKAGE.read_version;
const PACKAGE_FILE_FORMAT_VERSION = PACKAGE.file_format_version;
const COMPONENT_IDENTIFIER = COMPONENT.identifier;
const COMPONENT_PREFERRED_LOCATOR = COMPONENT.preferred_locator;
const COMPONENT_LOCATOR = COMPONENT.locator;
const COMPONENT_EXTERNAL_REFERENCES = COMPONENT.external_references;
const COMPONENT_DATA_REFERENCES = COMPONENT.data_references;
const EXTERNAL_COMPONENT = EXTERNAL.component_identifier;
const EXTERNAL_OBJECT = EXTERNAL.object_identifier;
const EXTERNAL_WEAK = EXTERNAL.is_weak;
const DATA_REFERENCE_IDENTIFIER = DATA_REFERENCE.data_identifier;
const DATA_IDENTIFIER = DATA.identifier;
const DATA_PREFERRED_FILE_NAME = DATA.preferred_file_name;
const DATA_FILE_NAME = DATA.file_name;

/** A required `uint64` field, or a `Malformed` failure naming it. */
const required = (fields: ReadonlyArray<Field>, n: number, what: string): bigint => {
  const value = getBigInt(fields, n);
  if (value === undefined) throw codecError("Malformed", `${what} has no identifier`, 0);
  return value;
};

/** A string field, if present. */
const stringField = (fields: ReadonlyArray<Field>, n: number): Option.Option<string> =>
  Option.map(Option.fromUndefinedOr(getBytes(fields, n)), decodeUtf8);

const componentReference = (bytes: Uint8Array): ComponentReference => {
  const f = parseMessage(bytes);
  return {
    component: required(f, EXTERNAL_COMPONENT, "ComponentExternalReference"),
    object: Option.fromUndefinedOr(getBigInt(f, EXTERNAL_OBJECT)),
    weak: getVarint(f, EXTERNAL_WEAK) === 1,
  };
};

const componentInfo = (bytes: Uint8Array): ComponentInfo => {
  const f = parseMessage(bytes);
  const locator = Option.orElse(stringField(f, COMPONENT_LOCATOR), () =>
    stringField(f, COMPONENT_PREFERRED_LOCATOR),
  );
  if (Option.isNone(locator)) throw codecError("Malformed", "ComponentInfo has no locator", 0);
  return {
    identifier: required(f, COMPONENT_IDENTIFIER, "ComponentInfo"),
    path: `Index/${locator.value}.iwa`,
    externalReferences: getAllBytes(f, COMPONENT_EXTERNAL_REFERENCES).map(componentReference),
    dataReferences: getAllBytes(f, COMPONENT_DATA_REFERENCES).map((d) =>
      required(parseMessage(d), DATA_REFERENCE_IDENTIFIER, "ComponentDataReference"),
    ),
  };
};

const dataInfo = (bytes: Uint8Array): DataInfo => {
  const f = parseMessage(bytes);
  return {
    identifier: required(f, DATA_IDENTIFIER, "DataInfo"),
    preferredFileName: Option.getOrElse(stringField(f, DATA_PREFERRED_FILE_NAME), () => ""),
    path: Option.map(stringField(f, DATA_FILE_NAME), (name) => `Data/${name}`),
  };
};

/** Decode a `TSP.PackageMetadata` message's payload. Throws a positioned `IworkError`. */
const packageMetadata = (payload: Uint8Array): PackageMetadata => {
  const f = parseMessage(payload);
  return {
    fileFormatVersion: getPacked(f, PACKAGE_FILE_FORMAT_VERSION, "varint").join("."),
    readVersion: getPacked(f, PACKAGE_READ_VERSION, "varint"),
    components: getAllBytes(f, PACKAGE_COMPONENTS).map(componentInfo),
    datas: getAllBytes(f, PACKAGE_DATAS).map(dataInfo),
  };
};

/** The metadata message among a component's objects. */
const metadataMessage = (objects: ReadonlyArray<IworkObject>): Option.Option<Uint8Array> =>
  Arr.findFirst(
    objects.flatMap((o) => o.messages),
    (m) => m.type === TSP_PACKAGE_METADATA,
  ).pipe(Option.map((m) => m.payload));

/**
 * Read a bundle's package metadata (#101). `None` when it has no
 * `Index/Metadata.iwa` or no `TSP.PackageMetadata` in it (some older or
 * partial packages); an `IworkError` located at the component when it is there
 * but malformed.
 */
export const readPackageMetadata = (
  bundle: IworkBundle,
  options?: DechunkOptions,
): Result.Result<Option.Option<PackageMetadata>, IworkError> =>
  Result.flatMap(decodeComponent(bundle, METADATA_COMPONENT, options), (objects) =>
    Option.match(metadataMessage(objects), {
      onNone: () => Result.succeed(Option.none()),
      onSome: (payload) =>
        Result.try({
          try: () => Option.some(packageMetadata(payload)),
          catch: (e) => withLocation(toIworkError(e), { component: METADATA_COMPONENT }),
        }),
    }),
  );

/** The data file with `identifier`, if the metadata lists it. */
export const dataInfoOf = (
  metadata: PackageMetadata,
  identifier: bigint,
): Option.Option<DataInfo> => Arr.findFirst(metadata.datas, (d) => d.identifier === identifier);
