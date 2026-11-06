/**
 * The OOXML XML utilities, re-exported here for backwards compatibility. The
 * canonical implementation now lives in `../shared/xml.ts` and is shared with the
 * docx and pptx formats. The list is explicit, so the XLSX entry keeps exactly
 * these: the shared module's other exports are for the readers alone.
 */

export {
  escapeAttr,
  escapeXml,
  findAll,
  findChild,
  findChildren,
  getAttr,
  parseXml,
  parseXmlResult,
  unescapeXml,
  type XmlElement,
} from "../shared/xml.ts";
