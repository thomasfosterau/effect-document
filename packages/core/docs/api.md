# API reference

The root entry re-exports everything; the subpaths expose one area each.

## `@thomasfosterau/effect-document/schema`

| Export | Kind | Description |
| --- | --- | --- |
| `InlineFeature` | type | Inline-level node features (prose). |
| `BlockFeature` | type | Block-level node features (prose). |
| `SheetFeature` | type | Spreadsheet features (the `Worksheet` block and its typed cells). |
| `DeckFeature` | type | Presentation features (the `SlideShow` block, its slides and shapes). |
| `DocFeature` | type | Document-level features: `doc.resources`, a media bag. |
| `AttrFeature` | type | Cross-cutting attribute-facet features (which kinds of `Attributes` are allowed). |
| `IdFeature` | type | Per-node id facets (`attr.id.header`, `attr.id.link`, …): an id allowed on one kind of node only. |
| `ID_FEATURE` | const | Each node's id facet, keyed by its tag (`TableCell` and `Slide` for the untagged ones). |
| `IdNode` | type | A node tag `ID_FEATURE` keys. |
| `idFeatureOf` | function | The id facet of a node with the given tag. |
| `WithIdFeatures` | type | A feature set with `attr.id` standing for every `IdFeature`, as `defineProfile` reads it. |
| `withIdFeatures` | function | A feature list with `attr.id` expanded to every per-node id facet. |
| `Feature` | type | Any capability the universal document schema can express. |
| `TAG_FEATURE` | const | Maps a node's `_tag` to the feature it represents. |
| `TaggedNode` | type | Any document node whose tag `TAG_FEATURE` maps to a feature. |
| `featureOfTag` | function | The feature represented by a node's tag, if the tag is mapped. |
| `ALL_INLINE_FEATURES` | const | Every inline feature, for assembling profiles. |
| `ALL_BLOCK_FEATURES` | const | Every prose block feature, for assembling profiles. |
| `ALL_SHEET_FEATURES` | const | Every spreadsheet feature (worksheets and cell types), for assembling profiles. |
| `ALL_DECK_FEATURES` | const | Every presentation feature (slide shows and shapes), for assembling profiles. |
| `ALL_DOC_FEATURES` | const | Every document-level feature, for assembling profiles. |
| `ALL_ATTR_FEATURES` | const | Every attribute facet feature, for assembling profiles. |
| `ALL_ID_FEATURES` | const | Every per-node id facet. |
| `ALL_FEATURES` | const | Every feature in the schema - the maximal ("Full") profile's allow-set. |
| `AttrValue` | const | A JSON-compatible value usable as a custom attribute. |
| `HorizontalAlign` | const | Horizontal alignment of text in a paragraph or cell. |
| `VerticalAlign` | const | Vertical alignment of content in a cell. |
| `FontProps` | const | Character-level font properties. |
| `Style` | const | Structured visual styling. |
| `Attributes` | const | The attribute bundle carried by document nodes. |
| `attrField` | const | An optional `attr` field for a node schema. |
| `noAttr` | const | The empty attribute bundle. |
| `AttrPolicy` | interface | Declares which attribute facets a profile permits. |
| `usedAttrFeatures` | function | The attribute facets actually populated on an `Attributes` value. |
| `policyFeatures` | function | The attribute facets a policy permits, as features. |
| `Str` | class | A run of literal text. |
| `Space` | class | Inter-word space. |
| `SoftBreak` | class | A soft line break (a newline that may be re-wrapped). |
| `LineBreak` | class | A hard line break. |
| `Emph` | class | Emphasized (italic) content. |
| `Strong` | class | Strongly emphasized (bold) content. |
| `Underline` | class | Underlined content. |
| `Strikeout` | class | Struck-out content. |
| `Superscript` | class | Superscripted content. |
| `Subscript` | class | Subscripted content. |
| `SmallCaps` | class | Small-caps content. |
| `QuoteType` | const | Which quotation marks a `Quoted` inline uses. |
| `Quoted` | class | Quoted content (rendered with locale-appropriate quotation marks). |
| `CitationMode` | const | How a citation renders. |
| `Citation` | class | A single citation within a `Cite`. |
| `Cite` | class | A citation cluster. |
| `Code` | class | Inline code span. |
| `MathType` | const | Whether a `Math` inline is set inline or as display math. |
| `Math` | class | Inline or display math (TeX). |
| `RawInline` | class | Raw inline content in a named target format (e.g. |
| `Target` | const | A link target. |
| `Link` | class | A hyperlink. |
| `Comment` | class | A review comment: author, initials, date, resolved mark, body blocks and replies. |
| `CellComment` | class | A `Comment` anchored to a worksheet cell by its 0-based row and column. |
| `withSheetComments` | function | A worksheet with its cell comments set. |
| `Image` | class | An image; `alt` is its alternate-text inlines. |
| `Note` | class | A footnote/endnote, containing block content. |
| `Span` | class | A generic inline container carrying attributes. |
| `Inline` | const | Any inline-level node. |
| `Plain` | class | Inline content without paragraph semantics (used in tight contexts). |
| `Para` | class | A paragraph. |
| `LineBlock` | class | Lines whose breaks are significant (verse, addresses). |
| `CodeBlock` | class | A block of preformatted code. |
| `RawBlock` | class | Raw block content in a named target format. |
| `BlockQuote` | class | A block quotation. |
| `ListNumberStyle` | const | The numbering style of an ordered list (Pandoc `ListNumberStyle`). |
| `ListNumberDelim` | const | The punctuation after an ordered list number (Pandoc `ListNumberDelim`). |
| `OrderedList` | class | An ordered (numbered) list; each item is a sequence of blocks. |
| `BulletList` | class | A bullet (unordered) list. |
| `DefinitionItem` | class | A term-with-definitions entry in a definition list. |
| `DefinitionList` | class | A definition list. |
| `Header` | class | A section heading (level 1-6). |
| `HorizontalRule` | class | A horizontal rule / thematic break. |
| `Figure` | class | A figure. |
| `Div` | class | A generic block container carrying attributes. |
| `ColWidth` | const | A table column width as a fraction of the text width, or `null` for the default. |
| `ColSpec` | class | A column specification. |
| `TableCell` | class | A prose table cell, holding block content (Pandoc style). |
| `TableRow` | class | A row of prose-table cells. |
| `Table` | class | A prose table. |
| `CellText` | class | A text cell. |
| `CellNumber` | class | A numeric cell. |
| `CellBoolean` | class | A boolean cell. |
| `CellDate` | class | A date/time cell (a genuine date value, distinct from a number). |
| `CellError` | class | An error cell (carries the error literal, e.g. |
| `CellBlank` | class | An empty cell. |
| `CellFormula` | class | A formula cell. |
| `CellRichText` | class | A rich-text cell with character-level formatting (inline runs). |
| `SheetCell` | const | Any typed spreadsheet cell. |
| `SheetColumn` | class | A column definition (width / default style). |
| `PlainCell` | const | A finite number, string or boolean standing in a row for its unstyled cell node. |
| `RowCell` | const | One position of a row: its cell (a node or a plain cell), or `undefined` for a gap (`null` in JSON). |
| `SheetRow` | class | A spreadsheet row: its 0-based `index` and its cells by position (`undefined` a gap, the last a cell). |
| `PlainRow` | schema | A row's cells alone, standing in a worksheet's `rows` for the row one past the one before it, with no height; a bare array in JSON. |
| `isPlainRow` | function | Whether a worksheet row is a plain row rather than a `SheetRow`. |
| `MergeRange` | class | A rectangular merged-cell range (0-based, inclusive). |
| `Worksheet` | class | A spreadsheet worksheet: a named, sparse grid of typed cells. |
| `TextBox` | class | A text box shape. |
| `Picture` | class | A picture shape. |
| `TableShape` | class | A table shape (wraps a prose `Table`). |
| `Placeholder` | class | A layout placeholder shape (title, body, ...). |
| `Shape` | const | Any slide shape. |
| `Slide` | class | A single slide. |
| `SlideSize` | class | Deck-level geometry (EMU or px, by convention of the producing format). |
| `SlideShow` | class | A presentation deck. |
| `Block` | const | Any block-level node (prose, spreadsheet, or presentation). |
| `Meta` | const | Document metadata (title, author, arbitrary key/values). |
| `Document` | class | A complete document: metadata, blocks and, when it embeds any, its media bag (`resources`). |
| `str` | function | A `Str`. |
| `emph` | function | An `Emph` (emphasis, usually italic) around `content`. |
| `strong` | function | A `Strong` (strong emphasis, usually bold) around `content`. |
| `link` | function | A `Link` to `url` (with an optional `title`) around `content`. |
| `para` | function | A `Para`. |
| `plain` | function | A `Plain` block. |
| `plainText` | function | A `Plain` block holding a single `Str` of `text`. |
| `header` | function | A `Header` of `level` 1–6 around `content`. |
| `codeBlock` | function | A `CodeBlock` of verbatim `text`, optionally tagged with its `language`. |
| `bulletList` | function | A `BulletList`; each item is a sequence of blocks. |
| `orderedList` | function | An `OrderedList` with default numbering; each item is a sequence of blocks. |
| `table` | function | A prose table from header strings and a grid of block-cell content. |
| `cell` | const | Ergonomic spreadsheet-cell constructors. |
| `worksheet` | function | A worksheet from optional header strings and a grid of cells. |
| `textBox` | function | A `TextBox` shape holding prose blocks. |
| `slide` | function | A `Slide` of `shapes`, with optional speaker `notes`. |
| `slideShow` | function | A `SlideShow` block. |
| `document` | function | Construct a document from blocks, with optional metadata and media bag. |
| `resourceOf` | function | The resource a `resource:` URL in a document refers to, as an `Option`. |
| `withResource` | function | A document with a resource added to its media bag (deduplicated by content), and the URL to refer to it by. |
| `WithResource` | interface | What `withResource` returns. |
| `Resource` | class | One binary resource: its bytes (base64 in JSON), media type and optional file name. |
| `ResourceEncoded` | type | The JSON form of a `Resource`. |
| `Resources` | const | A document's media bag: resources by id. |
| `RESOURCE_SCHEME` | const | `"resource:"`, the scheme of a reference into the media bag. |
| `resourceUrl` / `resourceIdOf` | function | A resource id to its `resource:` URL, and back (`None` for any other URL). |
| `addResource` / `AddedResource` | function / interface | Add a resource to a media bag under its content id, returning the existing id for content it already holds. |
| `contentId` | function | An id derived from a resource's bytes. |
| `sameResource` | function | Whether two resources hold the same bytes of the same media type. |
| `imageInfo` | function | A PNG, JPEG, GIF or SVG's media type, pixel size and recorded resolution, read from its header. |
| `ImageInfo` / `Dpi` | interface | What `imageInfo` returns. |
| `emuExtent` / `EmuExtent` | function / interface | An image's natural size in EMUs (DOCX and PPTX extents). |
| `DEFAULT_DPI` / `EMU_PER_INCH` | const | 96, the resolution assumed when none is recorded; 914 400 EMUs to the inch. |
| `space` / `softBreak` / `lineBreak` | function | A `Space`, `SoftBreak` or `LineBreak`. |
| `underline` / `strikeout` / `superscript` / `subscript` / `smallCaps` | function | The formatting inlines around content. |
| `quoted` / `code` / `math` / `rawInline` | function | `Quoted` content (double quotes by default), inline `Code` (optional attributes), TeX `Math` (inline by default) and a format's verbatim `RawInline`. |
| `image` / `note` / `span` | function | An `Image` (alt inlines, optional title), a `Note` of blocks and a `Span` of inlines with attributes. |
| `blockQuote` / `div` / `figure` / `definitionList` / `lineBlock` / `horizontalRule` / `rawBlock` | function | The remaining prose blocks. |
| `picture` / `placeholder` | function | A `Picture` shape and a `Placeholder` shape. |
| `textInlines` | function | A string as `Str` / `Space` / `SoftBreak` inlines, as Pandoc's `text` builder splits it. |
| `normalizeInlines` | function | Inlines with adjacent `Str`s merged, empty ones dropped and whitespace runs collapsed (shallow). |
| `inlinesToText` | function | Collapse a sequence of inlines to plain text. |
| `cellToText` | function | Collapse a single spreadsheet cell to plain text. |
| `shapeToText` | function | Collapse a single slide shape to plain text. |
| `blocksToText` | function | Collapse a sequence of blocks to plain text (one line per block). |
| `SheetExtent` | interface | A worksheet's extent: one past its last row index and one past its last column. |
| `sheetExtent` | function | The extent of a worksheet. |
| `DEFAULT_MAX_DENSE_CELLS` | const | The default `DenseRowsOptions.maxCells`: five million cells. |
| `DenseGridTooLarge` | class | A worksheet's dense grid would be larger than the budget it was asked for under. |
| `DenseRowsOptions` | interface | Options for `denseRows` and `denseSize`. |
| `denseSize` | function | The cells `denseRows` would allocate for a worksheet, plus one per row. |
| `denseRows` | function | The derived dense view of a worksheet, built only within a cell budget. |
| `sheetRow` | function | A row from its cells by position (`undefined` a gap), the array copied. |
| `worksheetFromRows` | function | A worksheet of finished rows, for readers that build each row as they go (`sheetRow`, `sparseRow`). |
| `withSheetLayout` | function | A worksheet with its column definitions and merged ranges set, its rows kept unchecked (a reader's layout, read apart from its rows). |
| `sheetRowFrom` | function | A dense row built from any values, the cell at column `n` being `toCell(items[n], n)`. |
| `sheetRowOf` | function | A row holding the array of cells it is given (not copied): for readers that build one per line. |
| `rowEntries` | function | The cells a row holds with their columns, as nodes, gaps left out. |
| `rowsOf` | function | A worksheet's rows as `SheetRow` nodes (a plain row's built on demand). |
| `rowIndexes` | function | The index of each of a worksheet's rows, explicit or implied, in one array. |
| `rowCellsOf` | function | A worksheet row's cells, `SheetRow` or plain, without building a node. |
| `worksheetOfTrustedRows` | function | A worksheet of rows its caller built valid itself, taken unchecked: the escape hatch for a reader's own output (`worksheetFromRows` checks every cell). |
| `sheetRowOfNumbers` | function | `sheetRowOf` for a row of plain numbers, checked without boxing them. |
| `cellOf` | function | The cell node a row position holds (a plain cell's unstyled node), or `undefined` for a gap. |
| `cellAt` | function | The cell node at a column of a row, or `undefined` where it has none. |
| `sparseRow` | function | A row from its cells' `[column, cell]` entries, in strictly ascending column order (each column between a gap): the readers' constructor for rows whose cells skip columns. |
| `NestedNode` | type | A node that counts as one level of nesting. |
| `DEFAULT_MAX_NESTING_DEPTH` | const | The default maximum nesting depth readers accept. |
| `nestedChildren` | function | The blocks, inlines and shapes directly inside a node. |
| `blocksNestingDepth` | function | The deepest chain of nested blocks, inlines and shapes in `blocks`. |
| `nestingDepth` | function | The nesting depth of a document's blocks; see `blocksNestingDepth`. |
| `encodeDocument` | function | Encode a document to its JSON form as `Schema.encodeEffect(Document)` does, at any nesting depth. |
| `decodeDocument` | function | Decode a document from its JSON form as `Schema.decodeUnknownEffect(Document)` does, at any nesting depth. |
| `encodeDocumentResult` | function | `encodeDocument` as a synchronous `Result`. |
| `decodeDocumentResult` | function | `decodeDocument` as a synchronous `Result`. |
| `candidateTables` | function | Every tabular region of a document (worksheets, prose tables, slide table shapes), in document order, each with a locator, its size and a header guess. |
| `TableRegion` | type | One tabular region: a `WorksheetRegion` or a `ProseTableRegion`. |
| `WorksheetRegion` | interface | A worksheet as a candidate table: its locator, name, extent and header guess. |
| `ProseTableRegion` | interface | A prose table as a candidate table: its locator, caption, size, head rows, text grid and merged cells. |
| `CellSpan` | interface | A merged cell of a prose table: its top-left position and how far it spans. |
| `TableLocator` | type | Where a region is in its document, as a loss entry's path is. |

## `@thomasfosterau/effect-document/profile`

| Export | Kind | Description |
| --- | --- | --- |
| `Profiles` | namespace | The built-in profiles (`Csv`, `Spreadsheet`, `Markdown`, `Html`, `Presentation`, `Full`) as one namespace. |
| `DocBrand` | interface | Phantom marker carrying the feature set a document is permitted to use. |
| `Doc` | type | A `Document` statically restricted to the features `F`. |
| `FeaturesOf` | type | The feature set of a profile, as a phantom-bearing type. |
| `Profile` | interface | A named subset of the schema. |
| `defineProfile` | function | Define a profile from its complete allow-set of features, with optional structural rules (`notWithin`, `onlyWithin`, `fieldValues`, `whole`). |
| `NotWithin` | interface | A structural rule: a feature the profile allows, but not inside a given node. |
| `unionProfiles` | function | A profile allowing what either of two allows, keeping only the structural rules both share. |
| `intersectProfiles` | function | A profile allowing only what both of two allow, under every structural rule of either. |
| `withoutFeatures` | function | A profile without some features and the structural rules about them. |
| `extendProfile` | function | A profile with some features added, keeping its structural rules. |
| `isSubProfile` | function | Whether every document one profile accepts, another accepts too (features and the rules that apply). |
| `IsSubProfile` | type | Whether one profile's features are all another's, at the type level. |
| `profileOf` | function | The smallest profile a document conforms to: exactly the features it uses. |
| `OnlyWithin` | interface | A structural rule: a feature the profile allows only inside a given node (one whose fields satisfy `where`, when given). |
| `FieldValues` | interface | A structural rule: the values a node's field may hold. |
| `FieldMatch` | interface | A condition on one of a node's own fields: it holds one of `oneOf`. |
| `RuleValue` | type | A value a structural rule compares a node's field with: a string, number or boolean. |
| `ProfileOptions` | interface | Options for `defineProfile`: structural rules beyond the feature set. |
| `trustAs` | function | Assert (unsafely) that a document belongs to a profile, branding it without a runtime check. |
| `collectFeatures` | function | The set of features a document uses. |
| `collectFeaturesWithin` | function | The features a document uses inside nodes of a given feature. |
| `unsupportedFeatures` | function | Features the document uses that are not in `allowed`. |
| `LossEntry` | schema | One thing `narrow` could not keep: the feature, the action, its severity, its path and why. |
| `LossReport` | schema | Everything a narrowing (or a conversion) dropped or down-converted: the entries, their summary, the reader's and writer's diagnostics, and whether anything was lost. |
| `Diagnostic` | schema | A non-fatal issue a reader or writer met: format, stage, `code`, severity, path and detail. |
| `logDiagnostic` / `logDiagnostics` | function | Report diagnostics as annotated warning log records. |
| `collectDiagnostics` | function | Run an effect and return its result with the diagnostics it reported. |
| `LossSummaryItem` | schema | How many times a feature was lost the same way, and where the first few were. |
| `LossSeverity` | schema | How bad a loss is: `dropped-content`, `dropped-formatting` or `converted`. |
| `LossPathSegment` | schema | One step of a loss entry's path: a child's index, a part's name or a cell's A1 address. |
| `LOSS_SUMMARY_PATHS` | const | How many paths a summary item keeps (5). |
| `lossReport` | function | The report for a list of entries: their summary, and whether there are none. |
| `severityOf` | function | The severity of losing a feature by an action. |
| `NarrowResult` | interface | The narrowed document and the loss report for it. |
| `widen` | function | Widen a document to a superset profile. |
| `narrow` | function | Narrow a document so it conforms to `to`, recording everything that had to be dropped or down-converted. |
| `narrowEffect` | function | Narrow within an Effect. |

## `@thomasfosterau/effect-document/profiles`

| Export         | Kind  | Description                    |
| -------------- | ----- | ------------------------------ |
| `csvFeatures`  | const | CSV/TSV.                       |
| `Csv`          | const | The CSV profile.               |
| `Spreadsheet`  | const | A full spreadsheet (XLSX/ODS). |
| `Markdown`     | const | Markdown/Wikitext.             |
| `Html`         | const | HTML/OOXML/ODF prose.          |
| `Presentation` | const | Presentations (PPTX/Keynote).  |
| `Full`         | const | The maximal profile.           |

## `@thomasfosterau/effect-document/io`

| Export | Kind | Description |
| --- | --- | --- |
| `ParseError` | class | A reader failed to parse source content into the document schema. |
| `ParseErrorCode` | schema | What kind of failure a `ParseError` is, shared by every reader (`InvalidContainer`, `WrongFormat`, `MissingPart`, `Encrypted`, `MalformedXml`, `MalformedBinary`, `MalformedText`, `LimitExceeded`, `Unsupported`). |
| `SourcePosition` | schema | Best-effort source position of a parse failure: `row`, `column`, `part`, `offset`, `component`, `object`, `sheet`, `cell`. |
| `WriteError` | class | A writer failed to render a document into target content. |
| `ProfileViolation` | class | A document used features outside a profile's allowed set. |
| `ConversionError` | class | A conversion pipeline could not be assembled, a bridge step failed, or `onLoss: "fail"` refused a lossy conversion (its `loss` holds the report). |
| `Text` | interface | Textual content. |
| `Bytes` | interface | Binary content. |
| `Content` | type | Raw content accepted by readers and produced by writers. |
| `text` | function | Construct textual content. |
| `bytes` | function | Construct binary content. |
| `contentToText` | function | View any content as a string (bytes are decoded as UTF-8). |
| `contentToBytes` | function | View any content as bytes (text is encoded as UTF-8). |
| `Reader` | interface | Parses `Content` into a document of its format's profile, failing with a `ParseError`. |
| `AnyReader` | type | A `Reader` for some (existentially-quantified) profile. |
| `makeReaderTag` | function | Create a Context tag for a format's Reader service. |
| `limitNestingDepth` | function | Fail with a `"LimitExceeded"` ParseError when a document nests deeper than `maxDepth` (default `DEFAULT_MAX_NESTING_DEPTH`); otherwise succeed with it unchanged. |
| `Writer` | interface | Renders a document of its format's profile into `Content`, failing with a `WriteError`. |
| `AnyWriter` | type | A `Writer` for some (existentially-quantified) profile. |
| `makeWriterTag` | function | Create a Context tag for a format's Writer service. |
| `Format` | interface | A format bundle for `convert`, with an optional `sniff`, `extensions` and `mimeTypes` for `detect`. |
| `AnyFormat` | type | A `Format` for some (existentially-quantified) profiles. |
| `ConvertOptions` | interface | Options for `convert`. |
| `ConvertResult` | interface | The rendered target content and what was lost getting there. |
| `ConvertError` | type | Every way `convert` can fail. |
| `convert` | function | Convert content from one format to another. |
| `detect` | function | The formats some content may be, most likely first, each with its confidence and evidence; never fails. |
| `Sniffer` | type | A format's recogniser: `Option.some` with its confidence when the content looks like the format. |
| `Sniff` | interface | What a sniffer concluded: its confidence and evidence. |
| `Candidate` | interface | One format `detect` thinks the content may be. |
| `DetectHints` | interface | A file name and MIME type: tie-breakers only. |
| `DetectOptions` | interface | Options for `detect`: the formats to choose among, and the hints. |
| `Detectable` | interface | What `detect` needs of a format: its id, and its sniffer, extensions and MIME types. |
| `HINT_WEIGHT` | const | How much a matching extension or MIME type adds to a candidate's confidence (0.001). |
| `isTruncated` | function | Whether a document is a truncated preview read rather than the whole file. |
| `truncationOf` | function | What a truncated preview read left out: its `maxRows` and the worksheets it cut. |
| `markTruncated` | function | Mark a document as a truncated preview (`meta.truncated`), keeping its profile: for readers. |
| `Truncation` | interface | A preview read's limit and the worksheets it cut. |
| `TRUNCATED_META_KEY` | const | The metadata key a truncated preview read sets (`"truncated"`). |

Every node class also has a `*Encoded` interface: its JSON form (`ParaEncoded`, `WorksheetEncoded`, …), which is what `Schema.encode` produces.

## `@thomasfosterau/effect-document/encoding`

Text encoding detection and decoding, on `@thomasfosterau/effect-ext`'s `/Encoding`, a dependency only this entry loads.

| Export | Kind | Description |
| --- | --- | --- |
| `detectEncoding` | function | The encoding bytes look like, from their first 64 KiB: a byte-order mark, UTF-16 by its zero bytes, valid UTF-8, or Windows-1252, with a confidence and evidence. Never fails. |
| `DetectedEncoding` | interface | What `detectEncoding` found: `encoding`, `confidence`, `evidence` and whether there is a byte-order mark (`bom`). |
| `decodeText` | function | Content as `Text`, decoded strictly with the encoding given or detected, a byte-order mark stripped; fails with a `ParseError` (`MalformedText`, `Unsupported`). |
| `DecodeTextOptions` | interface | `decodeText`'s options: the `encoding` to decode with. |
| `ENCODING_NAMES` | const | The encodings `decodeText` takes, by their WHATWG names. |
| `ENCODING_SAMPLE_BYTES` | const | How much of the input `detectEncoding` looks at: 64 KiB. |
