/**
 * Attributes attach to most document nodes. They carry the well-known facets
 * Pandoc models (`id`, `classes`) plus structured presentation `style` and an
 * open `data` map for arbitrary, format-specific custom attributes.
 *
 * Which facets a given profile permits is described by an {@link AttrPolicy};
 * poorer formats (Markdown, RTF) allow only `id`/`classes`, while richer ones
 * (HTML, OOXML) allow `style` and arbitrary key/values too.
 */

import { Schema } from "effect";
import type { AttrFeature } from "./feature.js";

// ============================================================================
// Attribute values (JSON-ish, for the open `data` map)
// ============================================================================

/** A JSON-compatible value usable as a custom attribute. */
export type AttrValue =
  | string
  | number
  | boolean
  | null
  | ReadonlyArray<AttrValue>
  | { readonly [key: string]: AttrValue };

export const AttrValue: Schema.Schema<AttrValue> = Schema.suspend(() =>
  Schema.Union(
    Schema.String,
    Schema.Number,
    Schema.Boolean,
    Schema.Null,
    Schema.Array(AttrValue),
    Schema.Record({ key: Schema.String, value: AttrValue })
  )
);

// ============================================================================
// Style (structured presentation properties)
// ============================================================================

export const HorizontalAlign = Schema.Literal(
  "left",
  "right",
  "center",
  "justify",
  "default"
);
export type HorizontalAlign = Schema.Schema.Type<typeof HorizontalAlign>;

export const VerticalAlign = Schema.Literal("top", "middle", "bottom");
export type VerticalAlign = Schema.Schema.Type<typeof VerticalAlign>;

/** Character-level font properties. */
export const FontProps = Schema.Struct({
  family: Schema.optional(Schema.String),
  /** Size in points. */
  size: Schema.optional(Schema.Number),
  bold: Schema.optional(Schema.Boolean),
  italic: Schema.optional(Schema.Boolean),
  underline: Schema.optional(Schema.Boolean),
  strike: Schema.optional(Schema.Boolean),
  /** Foreground color, as an ARGB/RGB hex string or CSS color. */
  color: Schema.optional(Schema.String),
});
export type FontProps = Schema.Schema.Type<typeof FontProps>;

/**
 * Structured visual styling. Kept deliberately small and orthogonal to content;
 * the open `data` map on {@link Attributes} carries anything not modelled here.
 */
export const Style = Schema.Struct({
  font: Schema.optional(FontProps),
  /** Background color (ARGB/RGB hex or CSS color). */
  background: Schema.optional(Schema.String),
  align: Schema.optional(HorizontalAlign),
  verticalAlign: Schema.optional(VerticalAlign),
  /** A number-format code (spreadsheet cells), e.g. "0.00" or "yyyy-mm-dd". */
  numberFormat: Schema.optional(Schema.String),
});
export type Style = Schema.Schema.Type<typeof Style>;

// ============================================================================
// Attributes
// ============================================================================

/**
 * The attribute bundle carried by document nodes. Every facet is optional, so a
 * node with no attributes simply omits the field.
 */
export const Attributes = Schema.Struct({
  /** A unique identifier (Pandoc `Attr` id, HTML `id`, ...). */
  id: Schema.optional(Schema.String),
  /** Class names (Pandoc `Attr` classes, HTML `class`, ...). */
  classes: Schema.optional(Schema.Array(Schema.String)),
  /** Structured visual styling. */
  style: Schema.optional(Style),
  /** Arbitrary, format-specific custom attributes (Pandoc key/value pairs, ...). */
  data: Schema.optional(Schema.Record({ key: Schema.String, value: AttrValue })),
});
export type Attributes = Schema.Schema.Type<typeof Attributes>;

/** An optional `attr` field for a node schema. */
export const attrField = Schema.optional(Attributes);

/** The empty attribute bundle. */
export const noAttr: Attributes = {};

// ============================================================================
// Attribute policy (per-profile)
// ============================================================================

/** Declares which attribute facets a profile permits. */
export interface AttrPolicy {
  readonly id: boolean;
  readonly classes: boolean;
  /** The open `data` key/value map. */
  readonly keyValue: boolean;
  readonly style: boolean;
}

/** Ready-made attribute policies for common format families. */
export const AttrPolicy = {
  /** No attributes at all (CSV, plain text). */
  none: { id: false, classes: false, keyValue: false, style: false },
  /** Ids and classes only (Markdown, Wikitext). */
  basic: { id: true, classes: true, keyValue: false, style: false },
  /** Everything (HTML, OOXML, ODF). */
  rich: { id: true, classes: true, keyValue: true, style: true },
} as const satisfies Record<string, AttrPolicy>;

/** The attribute facets actually populated on an `Attributes` value. */
export const usedAttrFeatures = (a: Attributes | undefined): AttrFeature[] => {
  if (a === undefined) return [];
  const out: AttrFeature[] = [];
  if (a.id !== undefined) out.push("attr.id");
  if (a.classes !== undefined && a.classes.length > 0) out.push("attr.classes");
  if (a.data !== undefined && Object.keys(a.data).length > 0) out.push("attr.keyValue");
  if (a.style !== undefined) out.push("attr.style");
  return out;
};

/** The attribute facets a policy permits, as features. */
export const policyFeatures = (p: AttrPolicy): AttrFeature[] => {
  const out: AttrFeature[] = [];
  if (p.id) out.push("attr.id");
  if (p.classes) out.push("attr.classes");
  if (p.keyValue) out.push("attr.keyValue");
  if (p.style) out.push("attr.style");
  return out;
};
