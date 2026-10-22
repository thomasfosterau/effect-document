/**
 * A minimal slice of the reverse-engineered `MessageInfo.type` registry.
 *
 * The full type-id -> message mapping is large and version-specific (extracted
 * from the iWork app binaries). We vendor only the handful of ids needed to find
 * text, taken from the keynote-parser v14.4 mapping (MIT). These can drift
 * between iWork versions; they are sufficient for the current read slice.
 */

/** `TSWP.StorageArchive` - the word-processing text storage (body/title/cell text). */
export const TSWP_STORAGE_ARCHIVE: ReadonlySet<number> = new Set([2001, 2005]);

/** `TSWP.ShapeInfoArchive` - a shape that owns/inherits a text storage. */
export const TSWP_SHAPE_INFO_ARCHIVE = 2011;

/** `KN.SlideArchive` - a Keynote slide. */
export const KN_SLIDE_ARCHIVE: ReadonlySet<number> = new Set([5, 6]);

/** `KN.PlaceholderArchive` - a Keynote title/body/object placeholder. */
export const KN_PLACEHOLDER_ARCHIVE: ReadonlySet<number> = new Set([7, 12]);

/** `KN.DocumentArchive` - the Keynote document root. */
export const KN_DOCUMENT_ARCHIVE = 1;

/** `TP.DocumentArchive` - the Pages document root. */
export const TP_DOCUMENT_ARCHIVE = 10000;

/** `TN.DocumentArchive` / `TN.SheetArchive` - the Numbers document/sheet roots. */
export const TN_DOCUMENT_ARCHIVE = 1;
export const TN_SHEET_ARCHIVE = 2;

/** `TSP.Reference.identifier` - the object a reference points to. */
export const REFERENCE_IDENTIFIER_FIELD = 1;

/** Field numbers within `TSWP.StorageArchive`. */
export const STORAGE_TEXT_FIELD = 3; // repeated string text
export const STORAGE_KIND_FIELD = 1; // KindType (0=BODY, 1=HEADER, 2=FOOTNOTE, 3=TEXTBOX, 4=NOTE, 5=CELL)

/** `StorageArchive.KindType` values. */
export const STORAGE_KIND_NOTE = 4;
