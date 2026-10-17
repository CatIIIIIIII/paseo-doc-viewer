// Small generators for hostile inputs used by the post-0.4.0 audit tests (test/audit-*.test.ts).
import { rawZip, type RawEntry } from "../zip-builder";

const W = `xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"`;
const PARA = "<w:p><w:r><w:t>x</w:t></w:r></w:p>";

export function docxXml(paragraphs: number): string {
  return `<?xml version="1.0"?><w:document ${W}><w:body>${PARA.repeat(paragraphs)}</w:body></w:document>`;
}

// A docx whose main document part is not named *.xml, so zip.ts XML_PART never counts its tags.
export function docxWithHiddenMainPart(paragraphs: number, target = "word/document.bin"): Buffer {
  const types = `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/></Types>`;
  const rels = `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="${target}"/></Relationships>`;
  return rawZip([
    { name: "[Content_Types].xml", data: types },
    { name: "_rels/.rels", data: rels },
    { name: target, data: docxXml(paragraphs) },
  ]);
}

// Two central directory entries with the same name: zip.ts keeps the first, mammoth (JSZip) the last.
export function docxWithDuplicateMainPart(paragraphs: number, base: RawEntry[]): Buffer {
  return rawZip([...base, { name: "word/document.xml", data: docxXml(paragraphs) }]);
}

// One very wide row followed by many empty rows: csv.ts materialises a columnCount-wide row for each.
export function wideThenBlankCsv(columns: number, blankRows: number): string {
  return `${",".repeat(columns - 1)}\n${"\n".repeat(blankRows)}`;
}

// A PNG header (signature + IHDR) with the given size and no image data.
export function pngHeaderOnly(width: number, height: number, colorType = 6, bitDepth = 8): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (bytes: Buffer) => {
    let c = 0xffffffff;
    for (const byte of bytes) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const out = Buffer.alloc(8 + data.length + 4);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc(body), 8 + data.length);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = bitDepth;
  ihdr[9] = colorType;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IEND", Buffer.alloc(0))]);
}
