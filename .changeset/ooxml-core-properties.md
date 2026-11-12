---
"@thomasfosterau/effect-document": minor
---

feat: OOXML package metadata (#79). The DOCX, XLSX and PPTX readers put `docProps/core.xml` and `docProps/app.xml` into `Document.meta` (`title`, `subject`, `author`, `keywords`, `description`, `lastModifiedBy`, `revision`, `category`, `contentStatus`, `lang`, `created`, `modified`, and `creator` for the application, the keys the PDF format uses), and the writers write them back, adding the property parts to DOCX and PPTX packages. An unreadable part is a `<format>.metadataUnreadable` diagnostic; a `created` or `modified` that is not W3CDTF is skipped with `<format>.metadataSkipped`.
