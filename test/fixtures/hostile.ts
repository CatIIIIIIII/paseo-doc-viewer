// Small generators for hostile inputs used by the post-0.4.0 audit tests (test/audit-*.test.ts).
import { crc32, deflateSync } from "node:zlib";
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

// A PNG whose IHDR claims the given size but whose IDAT holds only a few bytes.
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
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(Buffer.alloc(64))), chunk("IEND", Buffer.alloc(0))]);
}

// A one-page PDF whose content draws a Form XObject that draws the next level `fanout` times,
// `depth` levels deep: fanout^depth tiny paint operations from a file of a few KB.
export function nestedFormPdf(depth: number, fanout = 4): Buffer {
  const objects: string[] = [];
  const add = (body: string) => objects.push(body) + 2; // object numbers start at 3 (1 catalog, 2 pages)
  const stream = (dict: string, content: string) => `<< ${dict} /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`;
  let previous = add(stream("/Type /XObject /Subtype /Form /BBox [0 0 200 200]", "0 0 0 rg 10 10 180 180 re f"));
  for (let level = 1; level <= depth; level++) {
    const step = 200 / Math.ceil(Math.sqrt(fanout));
    const draws = Array.from({ length: fanout }, (_, i) => {
      const x = (i % Math.ceil(Math.sqrt(fanout))) * step;
      const y = Math.floor(i / Math.ceil(Math.sqrt(fanout))) * step;
      return `q ${step / 200} 0 0 ${step / 200} ${x} ${y} cm /P Do Q`;
    }).join("\n");
    previous = add(stream(`/Type /XObject /Subtype /Form /BBox [0 0 200 200] /Resources << /XObject << /P ${previous} 0 R >> >>`, draws));
  }
  const contents = add(stream("", "q /X Do Q"));
  const page = add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /XObject << /X ${previous} 0 R >> >> /Contents ${contents} 0 R >>`);
  const all = ["<< /Type /Catalog /Pages 2 0 R >>", `<< /Type /Pages /Kids [${page} 0 R] /Count 1 >>`, ...objects];
  let out = "%PDF-1.7\n";
  const offsets: number[] = [];
  all.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out));
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${all.length + 1}\n0000000000 65535 f \n${offsets.map((at) => `${String(at).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${all.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

// A one-page vector plot with `points` tiny filled squares, like a dense scatter plot export.
export function scatterPdf(points: number): Buffer {
  let seed = 1;
  const next = () => (seed = (seed * 48271) % 2147483647) / 2147483647;
  const ops: string[] = ["0 0 1 rg"];
  for (let i = 0; i < points; i++) ops.push(`${(next() * 590).toFixed(1)} ${(next() * 830).toFixed(1)} 1 1 re f`);
  const content = ops.join("\n");
  const all = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R >>",
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
  ];
  let out = "%PDF-1.7\n";
  const offsets: number[] = [];
  all.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out));
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${all.length + 1}\n0000000000 65535 f \n${offsets.map((at) => `${String(at).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${all.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

// Same layout as zip-builder rawZip, but every entry is STORED (method 0), so zip.ts streams it in
// 256 KB read chunks instead of ~16 KB inflate chunks.
export function storedZip(entries: { name: string; data: string | Buffer }[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const data = Buffer.from(entry.data);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, data);
    centrals.push(central, name);
    offset += local.length + name.length + data.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}
