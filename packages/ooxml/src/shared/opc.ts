/**
 * Open Packaging Conventions (OPC) helpers shared by the OOXML formats.
 *
 * An OOXML file (.xlsx/.docx/.pptx) is a ZIP of XML "parts" wired together by
 * relationship (`.rels`) files. These helpers read parts and resolve
 * relationships on the way in, and zip a set of parts on the way out.
 */

import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { findChildren, getAttr, parseXml } from "./xml.js";

/** A resolved relationship from a `.rels` file. */
export interface Relationship {
  readonly id: string;
  readonly type: string;
  /** Package-absolute target path (leading slash stripped). */
  readonly target: string;
}

/** Resolve a relationship target against the base directory of its source part. */
export const resolveTarget = (baseDir: string, target: string): string => {
  if (target.startsWith("/")) return target.substring(1);
  const segments = [...baseDir.split("/").filter((s) => s !== ""), ...target.split("/")];
  const resolved: string[] = [];
  for (const segment of segments) {
    if (segment === "..") resolved.pop();
    else if (segment !== ".") resolved.push(segment);
  }
  return resolved.join("/");
};

const dirOf = (path: string): string => {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? "" : path.substring(0, slash);
};

const fileOf = (path: string): string => {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? path : path.substring(slash + 1);
};

/** A read-only view over an unzipped OPC package. */
export class OpcReader {
  readonly files: Record<string, Uint8Array>;

  constructor(bytes: Uint8Array) {
    this.files = unzipSync(bytes);
  }

  /** The raw bytes of a part, or null if absent. */
  bytes(path: string): Uint8Array | null {
    const p = path.startsWith("/") ? path.substring(1) : path;
    return this.files[p] ?? null;
  }

  /** The UTF-8 text of a part, or null if absent. */
  text(path: string): string | null {
    const b = this.bytes(path);
    return b === null ? null : strFromU8(b);
  }

  /** The relationships declared for the given part (resolved to absolute paths). */
  rels(partPath: string): ReadonlyArray<Relationship> {
    const dir = dirOf(partPath);
    const relsPath = (dir ? dir + "/" : "") + "_rels/" + fileOf(partPath) + ".rels";
    const xml = this.text(relsPath);
    if (xml === null) return [];
    const root = parseXml(xml);
    return findChildren(root, "Relationship").map((r) => {
      const target = getAttr(r, "Target") ?? "";
      // External targets (hyperlink URLs, etc.) are absolute - never resolve them.
      const external = getAttr(r, "TargetMode") === "External";
      return {
        id: getAttr(r, "Id") ?? "",
        type: getAttr(r, "Type") ?? "",
        target: external ? target : resolveTarget(dir, target),
      };
    });
  }

  /** Resolve the single root-relationship target whose type ends with `suffix`. */
  rootTarget(suffix: string, fallback: string): string {
    const rootRels = this.rels(""); // "_rels/.rels"
    return rootRels.find((r) => r.type.endsWith(suffix))?.target ?? fallback;
  }
}

/** Zip a set of named parts into OPC package bytes. */
export const zipParts = (
  files: Record<string, string | Uint8Array>,
  level: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 = 6
): Uint8Array => {
  const encoded: Record<string, Uint8Array> = {};
  for (const [path, content] of Object.entries(files)) {
    encoded[path] = typeof content === "string" ? strToU8(content) : content;
  }
  return zipSync(encoded, { level });
};

/** The standard XML declaration prefixed to every OOXML part. */
export const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

/** The OPC package-relationships namespace. */
export const NS_PKG_REL = "http://schemas.openxmlformats.org/package/2006/relationships";
/** The officeDocument relationships namespace. */
export const NS_REL_DOC = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
/** The content-types namespace. */
export const NS_CONTENT_TYPES = "http://schemas.openxmlformats.org/package/2006/content-types";
