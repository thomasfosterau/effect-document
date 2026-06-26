/**
 * Opening an iWork bundle.
 *
 * A `.pages`/`.numbers`/`.key` is a zip whose serialized object graph lives in
 * `Index/*.iwa` components (older documents pack these into an inner `Index.zip`).
 * Media lives in `Data/`, light metadata in `Metadata/`. Password-protected
 * documents carry a top-level `.iwph` marker and are refused.
 */

import { unzipSync } from "fflate";
import { decodeArchiveStream, type IworkObject } from "./archive.js";
import { dechunk } from "./iwa.js";

export interface IworkBundle {
  /** Component path (e.g. "Index/Document.iwa") -> raw `.iwa` bytes. */
  readonly components: Record<string, Uint8Array>;
}

/** Open an iWork bundle, collecting its `.iwa` components. */
export const openBundle = (bytes: Uint8Array): IworkBundle => {
  const files = unzipSync(bytes);
  if (".iwph" in files) {
    throw new Error("encrypted (password-protected) iWork documents are not supported");
  }
  const components: Record<string, Uint8Array> = {};
  for (const [name, data] of Object.entries(files)) {
    if (name.toLowerCase().endsWith("index.zip")) {
      // older single-file documents nest the components in an inner Index.zip
      for (const [inner, innerData] of Object.entries(unzipSync(data))) {
        if (inner.endsWith(".iwa")) {
          components[inner.startsWith("Index/") ? inner : `Index/${inner}`] = innerData;
        }
      }
    } else if (name.endsWith(".iwa")) {
      components[name] = data;
    }
  }
  return { components };
};

/** The component paths matching a predicate (e.g. slides), in sorted order. */
export const componentPaths = (
  bundle: IworkBundle,
  match: (name: string) => boolean
): string[] => Object.keys(bundle.components).filter(match).sort();

/** Decode a single component's archived objects. */
export const decodeComponent = (bundle: IworkBundle, name: string): IworkObject[] => {
  const data = bundle.components[name];
  if (data === undefined) return [];
  return decodeArchiveStream(dechunk(data));
};

/** Decode every component's objects, flattened (a whole-document object scan). */
export const decodeAll = (bundle: IworkBundle): IworkObject[] =>
  Object.keys(bundle.components).flatMap((name) => decodeComponent(bundle, name));
