/**
 * Stand-ins for the schemas the ECMA-376 XSDs import but do not ship (#134).
 *
 * The OOXML schemas import the `xml:` namespace (W3C `xml.xsd`) and, for
 * core properties, the Dublin Core element and term namespaces by URL, and
 * `xmllint --nonet` fetches nothing. These declare just what the OOXML
 * schemas reference, with the published schemas' types: `xml:lang`,
 * `xml:space`, `xml:base` and `xml:id`; the Dublin Core elements as
 * `SimpleLiteral` (text with an optional `xml:lang`); and the terms, with
 * `W3CDTF` as the dates `dcterms:created` / `dcterms:modified` carry via
 * `xsi:type`.
 */

/** The `xml:` attributes (W3C `xml.xsd`). */
export const XML_XSD = `<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" targetNamespace="http://www.w3.org/XML/1998/namespace">
  <xs:attribute name="lang" type="xs:language"/>
  <xs:attribute name="space">
    <xs:simpleType>
      <xs:restriction base="xs:NCName">
        <xs:enumeration value="default"/>
        <xs:enumeration value="preserve"/>
      </xs:restriction>
    </xs:simpleType>
  </xs:attribute>
  <xs:attribute name="base" type="xs:anyURI"/>
  <xs:attribute name="id" type="xs:ID"/>
</xs:schema>
`;

const DC_ELEMENTS = [
  "title",
  "creator",
  "subject",
  "description",
  "publisher",
  "contributor",
  "date",
  "type",
  "format",
  "identifier",
  "source",
  "language",
  "relation",
  "coverage",
  "rights",
];

/** The Dublin Core elements (`dc:`), each a `SimpleLiteral`. */
export const DC_XSD = `<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns="http://purl.org/dc/elements/1.1/"
  targetNamespace="http://purl.org/dc/elements/1.1/" elementFormDefault="qualified">
  <xs:import namespace="http://www.w3.org/XML/1998/namespace"/>
  <xs:complexType name="SimpleLiteral">
    <xs:complexContent mixed="true">
      <xs:restriction base="xs:anyType">
        <xs:sequence>
          <xs:any processContents="lax" minOccurs="0" maxOccurs="0"/>
        </xs:sequence>
        <xs:attribute ref="xml:lang" use="optional"/>
      </xs:restriction>
    </xs:complexContent>
  </xs:complexType>
  <xs:element name="any" type="SimpleLiteral" abstract="true"/>
${DC_ELEMENTS.map((name) => `  <xs:element name="${name}" substitutionGroup="any"/>`).join("\n")}
</xs:schema>
`;

/** The Dublin Core terms (`dcterms:`) the core properties use, and the `W3CDTF` date type. */
export const DCTERMS_XSD = `<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:dc="http://purl.org/dc/elements/1.1/"
  xmlns="http://purl.org/dc/terms/" targetNamespace="http://purl.org/dc/terms/" elementFormDefault="qualified">
  <xs:import namespace="http://www.w3.org/XML/1998/namespace"/>
  <xs:import namespace="http://purl.org/dc/elements/1.1/"/>
  <xs:element name="created" type="dc:SimpleLiteral"/>
  <xs:element name="modified" type="dc:SimpleLiteral"/>
  <xs:complexType name="W3CDTF">
    <xs:simpleContent>
      <xs:restriction base="dc:SimpleLiteral">
        <xs:simpleType>
          <xs:union memberTypes="xs:gYear xs:gYearMonth xs:date xs:dateTime"/>
        </xs:simpleType>
        <xs:attribute ref="xml:lang" use="prohibited"/>
      </xs:restriction>
    </xs:simpleContent>
  </xs:complexType>
</xs:schema>
`;
