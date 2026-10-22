/**
 * Open Packaging Conventions (OPC) helpers shared by the OOXML formats.
 *
 * An OOXML file (.xlsx/.docx/.pptx) is a ZIP of XML "parts" wired together by
 * relationship (`.rels`) files. These helpers read parts and resolve
 * relationships on the way in, and zip a set of parts on the way out.
 */

import { strToU8, unzipSync, zipSync } from "fflate";
import type { ParseError as XmlSyntaxError } from "@thomasfosterau/effect-parse";
import { Result } from "effect";
import { findChildren, getAttr, parseXmlResult, type XmlElement } from "./xml.ts";

/** A resolved relationship from a `.rels` file. */
export interface Relationship {
  readonly id: string;
  readonly type: string;
  /** Package-absolute target path (leading slash stripped), or the URI of an external target. */
  readonly target: string;
  /** True for `TargetMode="External"` (hyperlink URLs and the like). */
  readonly external: boolean;
}

/** Percent-decode a part-name URI, leaving malformed escapes as they are. */
const decodePartName = (s: string): string => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

/** Resolve a relationship target against the base directory of its source part. */
export const resolveTarget = (baseDir: string, target: string): string => {
  const decoded = decodePartName(target.split("#")[0]!);
  if (decoded.startsWith("/")) return decoded.substring(1);
  const segments = [...baseDir.split("/").filter((s) => s !== ""), ...decoded.split("/")];
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

/** Resource limits for reading a package, guarding against zip bombs. */
export interface OpcLimits {
  /** The most entries the zip may list. Default 10,000. */
  readonly maxEntries: number;
  /** The most bytes one part may inflate to. Default 100 MiB. */
  readonly maxPartBytes: number;
  /** The most bytes all inflated parts together may take. Default 500 MiB. */
  readonly maxTotalBytes: number;
}

export const DEFAULT_OPC_LIMITS: OpcLimits = {
  maxEntries: 10_000,
  maxPartBytes: 100 * 1024 * 1024,
  maxTotalBytes: 500 * 1024 * 1024,
};

/** A package that breaks a resource limit or isn't the expected kind of package. */
export class OpcError extends Error {
  readonly kind: "LimitExceeded" | "WrongPackageType";

  constructor(kind: "LimitExceeded" | "WrongPackageType", message: string) {
    super(message);
    this.kind = kind;
  }
}

/** A part whose XML is malformed, with the parser's positioned error. */
export class XmlPartError extends Error {
  readonly part: string;
  readonly failure: XmlSyntaxError.ParseError<string>;

  constructor(part: string, failure: XmlSyntaxError.ParseError<string>) {
    super(`malformed XML in /${part}: ${failure.message}`);
    this.part = part;
    this.failure = failure;
  }
}

/** Decode UTF-16 code units (an unpaired surrogate becomes U+FFFD). */
const decodeUtf16 = (b: Uint8Array, bigEndian: boolean): string => {
  const units = new Uint16Array(b.length >> 1);
  for (let i = 0; i < units.length; i++) {
    units[i] = bigEndian ? (b[2 * i]! << 8) | b[2 * i + 1]! : b[2 * i]! | (b[2 * i + 1]! << 8);
  }
  let out = "";
  for (let i = 0; i < units.length; i += 8192) {
    out += String.fromCharCode(...units.subarray(i, i + 8192));
  }
  return out.toWellFormed();
};

/** Decode a part's bytes honouring a BOM or the XML declaration's encoding (UTF-8 or UTF-16). */
export const decodePart = (b: Uint8Array): string => {
  if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) return new TextDecoder("utf-8").decode(b.subarray(3));
  if (b[0] === 0xff && b[1] === 0xfe) return decodeUtf16(b.subarray(2), false);
  if (b[0] === 0xfe && b[1] === 0xff) return decodeUtf16(b.subarray(2), true);
  // No BOM: UTF-16 still shows as "<\0?\0" or "\0<\0?".
  if (b[0] === 0x3c && b[1] === 0x00) return decodeUtf16(b, false);
  if (b[0] === 0x00 && b[1] === 0x3c) return decodeUtf16(b, true);
  return new TextDecoder("utf-8").decode(b);
};

interface Entry {
  readonly name: string;
  readonly originalSize: number;
}

/**
 * A read-only view over an OPC package. Parts are inflated lazily, one at a
 * time when first read, within {@link OpcLimits}; part names match
 * case-insensitively, as OPC requires.
 */
export class OpcReader {
  private readonly entries = new Map<string, Entry>();
  private readonly cache = new Map<string, Uint8Array>();
  private readonly limits: OpcLimits;
  private inflated = 0;
  private contentTypes: { defaults: Map<string, string>; overrides: Map<string, string> } | null | undefined;

  private readonly data: Uint8Array;

  constructor(data: Uint8Array, limits?: Partial<OpcLimits>) {
    this.data = data;
    this.limits = { ...DEFAULT_OPC_LIMITS, ...limits };
    // List the central directory without inflating anything.
    unzipSync(data, {
      filter: (file) => {
        if (this.entries.size >= this.limits.maxEntries) {
          throw new OpcError("LimitExceeded", `package has more than ${this.limits.maxEntries} entries`);
        }
        this.entries.set(file.name.toLowerCase(), { name: file.name, originalSize: file.originalSize });
        return false;
      },
    });
  }

  /** The package's part names (as stored in the zip). */
  get partNames(): ReadonlyArray<string> {
    return [...this.entries.values()].map((e) => e.name);
  }

  /** The raw bytes of a part, or null if absent. */
  bytes(path: string): Uint8Array | null {
    const key = (path.startsWith("/") ? path.substring(1) : path).toLowerCase();
    const cached = this.cache.get(key);
    if (cached !== undefined) return cached;
    const entry = this.entries.get(key);
    if (entry === undefined) return null;
    if (entry.originalSize > this.limits.maxPartBytes) {
      throw new OpcError("LimitExceeded", `part ${entry.name} inflates to ${entry.originalSize} bytes, more than ${this.limits.maxPartBytes}`);
    }
    if (this.inflated + entry.originalSize > this.limits.maxTotalBytes) {
      throw new OpcError("LimitExceeded", `package inflates to more than ${this.limits.maxTotalBytes} bytes`);
    }
    const out = unzipSync(this.data, { filter: (file) => file.name === entry.name })[entry.name] ?? null;
    if (out === null) return null;
    this.inflated += out.length;
    this.cache.set(key, out);
    return out;
  }

  /** The text of a part (UTF-8 or UTF-16, by BOM or declaration), or null if absent. */
  text(path: string): string | null {
    const b = this.bytes(path);
    return b === null ? null : decodePart(b);
  }

  /** A part parsed as XML, or null if absent; malformed XML throws an {@link XmlPartError}. */
  xml(path: string): XmlElement | null {
    const text = this.text(path);
    if (text === null) return null;
    const result = parseXmlResult(text);
    if (Result.isFailure(result)) throw new XmlPartError(path.replace(/^\//, ""), result.failure);
    return result.success;
  }

  /** The relationships declared for the given part (resolved to absolute paths). */
  rels(partPath: string): ReadonlyArray<Relationship> {
    const dir = dirOf(partPath);
    const relsPath = (dir ? dir + "/" : "") + "_rels/" + fileOf(partPath) + ".rels";
    const root = this.xml(relsPath);
    if (root === null) return [];
    return findChildren(root, "Relationship").map((r) => {
      const target = getAttr(r, "Target") ?? "";
      // External targets (hyperlink URLs, etc.) are absolute - never resolve them.
      const external = getAttr(r, "TargetMode") === "External";
      return {
        id: getAttr(r, "Id") ?? "",
        type: getAttr(r, "Type") ?? "",
        target: external ? target : resolveTarget(dir, target),
        external,
      };
    });
  }

  /** Resolve the single root-relationship target whose type ends with `suffix`. */
  rootTarget(suffix: string, fallback: string): string {
    const rootRels = this.rels(""); // "_rels/.rels"
    return rootRels.find((r) => !r.external && r.type.endsWith(suffix))?.target ?? fallback;
  }

  /**
   * A part's content type from `[Content_Types].xml` (an Override for the part,
   * else the Default for its extension); undefined if the package declares none.
   */
  contentType(path: string): string | undefined {
    if (this.contentTypes === undefined) {
      const root = this.xml("[Content_Types].xml");
      if (root === null) this.contentTypes = null;
      else {
        this.contentTypes = {
          defaults: new Map(findChildren(root, "Default").map((d) => [(getAttr(d, "Extension") ?? "").toLowerCase(), getAttr(d, "ContentType") ?? ""])),
          overrides: new Map(findChildren(root, "Override").map((o) => [decodePartName(getAttr(o, "PartName") ?? "").replace(/^\//, "").toLowerCase(), getAttr(o, "ContentType") ?? ""])),
        };
      }
    }
    if (this.contentTypes === null) return undefined;
    const key = (path.startsWith("/") ? path.substring(1) : path).toLowerCase();
    const ext = key.includes(".") ? key.substring(key.lastIndexOf(".") + 1) : "";
    return this.contentTypes.overrides.get(key) ?? this.contentTypes.defaults.get(ext);
  }

  /**
   * Fail with a "WrongPackageType" OpcError when the main part's declared
   * content type isn't one of `accepted` (e.g. a .xlsx given to the DOCX
   * reader). Packages without `[Content_Types].xml` are not checked.
   */
  expectMainPart(path: string, format: string, accepted: ReadonlyArray<string>): void {
    if (this.text("[Content_Types].xml") === null) return;
    const type = this.contentType(path);
    if (type === undefined || !accepted.includes(type)) {
      throw new OpcError("WrongPackageType", `not a ${format} package: main part /${path} has content type "${type ?? "none"}"`);
    }
  }
}

/** The fixed timestamp written into zips so output is byte-for-byte deterministic. */
export const ZIP_MTIME = new Date("1980-01-01T00:00:00Z");

/** Zip a set of named parts into OPC package bytes. */
export const zipParts = (
  files: Record<string, string | Uint8Array>,
  level: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 = 6
): Uint8Array => {
  const encoded: Record<string, Uint8Array> = {};
  for (const [path, content] of Object.entries(files)) {
    encoded[path] = typeof content === "string" ? strToU8(content) : content;
  }
  return zipSync(encoded, { level, mtime: ZIP_MTIME });
};

/** The standard XML declaration prefixed to every OOXML part. */
export const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

/** The OPC package-relationships namespace. */
export const NS_PKG_REL = "http://schemas.openxmlformats.org/package/2006/relationships";
/** The officeDocument relationships namespace. */
export const NS_REL_DOC = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
/** The content-types namespace. */
export const NS_CONTENT_TYPES = "http://schemas.openxmlformats.org/package/2006/content-types";
