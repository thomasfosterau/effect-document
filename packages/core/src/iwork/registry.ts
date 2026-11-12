/**
 * The message type ids and field numbers the readers use, taken from the
 * generated `schema.generated.ts` (keynote-parser 14.5 and numbers-parser,
 * vendored under `vendor/iwork-protos/`; regenerate with
 * `vpx packages/core/scripts/generate-iwork-schema.ts`). The ids are
 * reverse-engineered from the iWork app binaries and can drift between app
 * versions.
 */

import { ENUMS, FIELDS, TYPE_IDS } from "./schema.generated.ts";

/** `TSWP.StorageArchive` - the word-processing text storage (body/title/cell text). */
export const TSWP_STORAGE_ARCHIVE: ReadonlySet<number> = new Set(TYPE_IDS["TSWP.StorageArchive"]);

/** `TSWP.ShapeInfoArchive` - a shape that owns/inherits a text storage. */
export const TSWP_SHAPE_INFO_ARCHIVE = TYPE_IDS["TSWP.ShapeInfoArchive"][0];

/** `KN.SlideArchive` - a Keynote slide. */
export const KN_SLIDE_ARCHIVE: ReadonlySet<number> = new Set(TYPE_IDS["KN.SlideArchive"]);

/** `KN.PlaceholderArchive` - a Keynote title/body/object placeholder. */
export const KN_PLACEHOLDER_ARCHIVE: ReadonlySet<number> = new Set(
  TYPE_IDS["KN.PlaceholderArchive"],
);

/** `KN.DocumentArchive` - the Keynote document root. */
export const KN_DOCUMENT_ARCHIVE = TYPE_IDS["KN.DocumentArchive"][0];

/** `KN.ShowArchive` - the show: its theme, size and slide tree (#99). */
export const KN_SHOW_ARCHIVE = TYPE_IDS["KN.ShowArchive"][0];

/** `KN.SlideNodeArchive` - one node of the slide tree: a slide and the slides nested under it (#99). */
export const KN_SLIDE_NODE_ARCHIVE = TYPE_IDS["KN.SlideNodeArchive"][0];

/**
 * Field numbers along the show's slide tree: `KN.DocumentArchive.show`,
 * `KN.ShowArchive.slideTree` (an embedded `KN.SlideTreeArchive`, not a
 * reference), `SlideTreeArchive.slides` and its deprecated `rootSlideNode`,
 * and `SlideNodeArchive.children` / `slide`.
 */
export const DOCUMENT_SHOW_FIELD = FIELDS["KN.DocumentArchive"].show;
export const SHOW_SLIDE_TREE_FIELD = FIELDS["KN.ShowArchive"].slideTree;
export const SLIDE_TREE_ROOT_NODE_FIELD = FIELDS["KN.SlideTreeArchive"].rootSlideNode;
export const SLIDE_TREE_SLIDES_FIELD = FIELDS["KN.SlideTreeArchive"].slides;
export const SLIDE_NODE_CHILDREN_FIELD = FIELDS["KN.SlideNodeArchive"].children;
export const SLIDE_NODE_SLIDE_FIELD = FIELDS["KN.SlideNodeArchive"].slide;

/**
 * `TP.DocumentArchive` - the Pages document root. Written by hand: it is in
 * neither upstream registry (keynote-parser's has no Pages types, and
 * numbers-parser's maps only Numbers and shared ones).
 */
export const TP_DOCUMENT_ARCHIVE = 10000;

/** `TN.DocumentArchive` / `TN.SheetArchive` - the Numbers document/sheet roots. */
export const TN_DOCUMENT_ARCHIVE = TYPE_IDS["TN.DocumentArchive"][0];
export const TN_SHEET_ARCHIVE = TYPE_IDS["TN.SheetArchive"][0];

/** `TN.DocumentArchive.sheets` (repeated `TSP.Reference`) and `TN.SheetArchive.name`. */
export const TN_DOCUMENT_SHEETS_FIELD = FIELDS["TN.DocumentArchive"].sheets;
export const TN_SHEET_NAME_FIELD = FIELDS["TN.SheetArchive"].name;

/**
 * `TSP.PackageMetadata` - the package's component and data-file lists, in
 * `Index/Metadata.iwa` (#101).
 */
export const TSP_PACKAGE_METADATA = TYPE_IDS["TSP.PackageMetadata"][0];

/** `TSP.Reference.identifier` - the object a reference points to. */
export const REFERENCE_IDENTIFIER_FIELD = FIELDS["TSP.Reference"].identifier;

/** Field numbers within `TSWP.StorageArchive`: the `KindType` and the repeated string `text`. */
export const STORAGE_TEXT_FIELD = FIELDS["TSWP.StorageArchive"].text;
export const STORAGE_KIND_FIELD = FIELDS["TSWP.StorageArchive"].kind;

/** `StorageArchive.KindType` values. */
export const STORAGE_KIND_NOTE = ENUMS["TSWP.StorageArchive.KindType"].NOTE;
