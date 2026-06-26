/**
 * Static PresentationML parts that every deck needs but that carry no document
 * content: one slide master, one (blank) slide layout, and a theme. They are
 * constant; only the slides and the presentation/relationship parts vary.
 */

import { NS_CONTENT_TYPES, NS_PKG_REL, NS_REL_DOC, XML_DECL } from "../ooxml/index.js";

export const NS_P = "http://schemas.openxmlformats.org/presentationml/2006/main";
export const NS_A = "http://schemas.openxmlformats.org/drawingml/2006/main";

export const CT_PRESENTATION =
  "application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml";
export const CT_SLIDE = "application/vnd.openxmlformats-officedocument.presentationml.slide+xml";
export const CT_SLIDE_MASTER =
  "application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml";
export const CT_SLIDE_LAYOUT =
  "application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml";
export const CT_THEME = "application/vnd.openxmlformats-officedocument.theme+xml";
export const CT_RELS = "application/vnd.openxmlformats-package.relationships+xml";

export const REL_OFFICE_DOCUMENT = NS_REL_DOC + "/officeDocument";
export const REL_SLIDE = NS_REL_DOC + "/slide";
export const REL_SLIDE_MASTER = NS_REL_DOC + "/slideMaster";
export const REL_SLIDE_LAYOUT = NS_REL_DOC + "/slideLayout";
export const REL_THEME = NS_REL_DOC + "/theme";

const emptySpTree =
  `<p:spTree>` +
  `<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>` +
  `<p:grpSpPr/>` +
  `</p:spTree>`;

export const themeXml = (): string => {
  const accents = ["4472C4", "ED7D31", "A5A5A5", "FFC000", "5B9BD5", "70AD47"]
    .map((c, i) => `<a:accent${i + 1}><a:srgbClr val="${c}"/></a:accent${i + 1}>`)
    .join("");
  const fill = `<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>`;
  const line = `<a:ln w="6350"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln>`;
  return (
    XML_DECL +
    `<a:theme xmlns:a="${NS_A}" name="Office Theme">` +
    `<a:themeElements>` +
    `<a:clrScheme name="Office">` +
    `<a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1>` +
    `<a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1>` +
    `<a:dk2><a:srgbClr val="44546A"/></a:dk2>` +
    `<a:lt2><a:srgbClr val="E7E6E6"/></a:lt2>` +
    accents +
    `<a:hlink><a:srgbClr val="0563C1"/></a:hlink>` +
    `<a:folHlink><a:srgbClr val="954F72"/></a:folHlink>` +
    `</a:clrScheme>` +
    `<a:fontScheme name="Office">` +
    `<a:majorFont><a:latin typeface="Calibri Light"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont>` +
    `<a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont>` +
    `</a:fontScheme>` +
    `<a:fmtScheme name="Office">` +
    `<a:fillStyleLst>${fill}${fill}${fill}</a:fillStyleLst>` +
    `<a:lnStyleLst>${line}${line}${line}</a:lnStyleLst>` +
    `<a:effectStyleLst>` +
    `<a:effectStyle><a:effectLst/></a:effectStyle>` +
    `<a:effectStyle><a:effectLst/></a:effectStyle>` +
    `<a:effectStyle><a:effectLst/></a:effectStyle>` +
    `</a:effectStyleLst>` +
    `<a:bgFillStyleLst>${fill}${fill}${fill}</a:bgFillStyleLst>` +
    `</a:fmtScheme>` +
    `</a:themeElements>` +
    `</a:theme>`
  );
};

export const slideMasterXml = (): string =>
  XML_DECL +
  `<p:sldMaster xmlns:p="${NS_P}" xmlns:r="${NS_REL_DOC}" xmlns:a="${NS_A}">` +
  `<p:cSld>${emptySpTree}</p:cSld>` +
  `<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>` +
  `<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst>` +
  `</p:sldMaster>`;

export const slideLayoutXml = (): string =>
  XML_DECL +
  `<p:sldLayout xmlns:p="${NS_P}" xmlns:r="${NS_REL_DOC}" xmlns:a="${NS_A}" type="blank" preserve="1">` +
  `<p:cSld name="Blank">${emptySpTree}</p:cSld>` +
  `<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>` +
  `</p:sldLayout>`;

export const slideMasterRelsXml = (): string =>
  XML_DECL +
  `<Relationships xmlns="${NS_PKG_REL}">` +
  `<Relationship Id="rId1" Type="${REL_SLIDE_LAYOUT}" Target="../slideLayouts/slideLayout1.xml"/>` +
  `<Relationship Id="rId2" Type="${REL_THEME}" Target="../theme/theme1.xml"/>` +
  `</Relationships>`;

export const slideLayoutRelsXml = (): string =>
  XML_DECL +
  `<Relationships xmlns="${NS_PKG_REL}">` +
  `<Relationship Id="rId1" Type="${REL_SLIDE_MASTER}" Target="../slideMasters/slideMaster1.xml"/>` +
  `</Relationships>`;

export const slideRelsXml = (): string =>
  XML_DECL +
  `<Relationships xmlns="${NS_PKG_REL}">` +
  `<Relationship Id="rId1" Type="${REL_SLIDE_LAYOUT}" Target="../slideLayouts/slideLayout1.xml"/>` +
  `</Relationships>`;

export const rootRelsXml = (): string =>
  XML_DECL +
  `<Relationships xmlns="${NS_PKG_REL}">` +
  `<Relationship Id="rId1" Type="${REL_OFFICE_DOCUMENT}" Target="ppt/presentation.xml"/>` +
  `</Relationships>`;

export const contentTypesXml = (slideCount: number): string => {
  const slides = Array.from(
    { length: slideCount },
    (_, i) => `<Override PartName="/ppt/slides/slide${i + 1}.xml" ContentType="${CT_SLIDE}"/>`
  ).join("");
  return (
    XML_DECL +
    `<Types xmlns="${NS_CONTENT_TYPES}">` +
    `<Default Extension="rels" ContentType="${CT_RELS}"/>` +
    `<Default Extension="xml" ContentType="application/xml"/>` +
    `<Override PartName="/ppt/presentation.xml" ContentType="${CT_PRESENTATION}"/>` +
    `<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="${CT_SLIDE_MASTER}"/>` +
    `<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="${CT_SLIDE_LAYOUT}"/>` +
    `<Override PartName="/ppt/theme/theme1.xml" ContentType="${CT_THEME}"/>` +
    slides +
    `</Types>`
  );
};
