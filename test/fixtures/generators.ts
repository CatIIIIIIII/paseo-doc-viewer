import { Writable } from "node:stream";
import { crc32, deflateSync } from "node:zlib";
import ExcelJS from "exceljs";
import JSZip from "jszip";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { PNG } from "pngjs";
import UTIF from "utif2";

const EPOCH = new Date("2026-01-01T00:00:00Z");

function xorshift(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 0;
  };
}

export function noisePng(width: number, height: number, seed = 1): Buffer {
  const png = new PNG({ width, height });
  const next = xorshift(seed);
  for (let i = 0; i < png.data.length; i += 4) {
    const value = next();
    png.data[i] = value & 0xff;
    png.data[i + 1] = (value >>> 8) & 0xff;
    png.data[i + 2] = (value >>> 16) & 0xff;
    png.data[i + 3] = 0xff;
  }
  return PNG.sync.write(png, { deflateLevel: 1 });
}

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typed = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed));
  return Buffer.concat([length, typed, crc]);
}

export function blankGrayPng(width: number, height: number): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 0;
  const row = Buffer.alloc(width + 1, 0xee);
  row[0] = 0;
  const raw = Buffer.alloc(row.length * height);
  for (let y = 0; y < height; y++) row.copy(raw, y * row.length);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(raw, { level: 1 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

export async function textPdf(pages: string[], size: [number, number] = [595, 842]): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setCreationDate(EPOCH);
  doc.setModificationDate(EPOCH);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const text of pages) {
    const page = doc.addPage(size);
    page.drawText(text, { x: 40, y: size[1] - 80, size: Math.max(24, size[0] / 30), font });
  }
  return doc.save({ useObjectStreams: false });
}

export function hugePagePdf(): Promise<Uint8Array> {
  return textPdf(["Huge page"], [14400, 14400]);
}

export async function wideWorkbook(columns: number, rows: number, longCellChars = 0): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.created = EPOCH;
  workbook.modified = EPOCH;
  const sheet = workbook.addWorksheet("Wide");
  for (let r = 1; r <= rows; r++) {
    const values: (string | number)[] = [];
    for (let c = 1; c <= columns; c++) values.push(r === 1 ? `C${c}` : r * 1000 + c);
    sheet.addRow(values);
  }
  if (longCellChars > 0) sheet.getCell(2, 1).value = "x".repeat(longCellChars);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

export async function formattedWorkbook(cells: { value: number | Date; numFmt?: string }[]): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.created = EPOCH;
  workbook.modified = EPOCH;
  const sheet = workbook.addWorksheet("Formats");
  cells.forEach(({ value, numFmt }, i) => {
    const cell = sheet.getCell(1, i + 1);
    cell.value = value;
    if (numFmt) cell.numFmt = numFmt;
  });
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

export async function streamedWorkbook(rows: number, columns: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, done) {
      chunks.push(chunk);
      done();
    },
  });
  const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({ stream, useSharedStrings: false, useStyles: false });
  const sheet = workbook.addWorksheet("Data");
  for (let r = 1; r <= rows; r++) sheet.addRow(Array.from({ length: columns }, (_, c) => `R${r}C${c + 1}`)).commit();
  sheet.commit();
  await workbook.commit();
  return Buffer.concat(chunks);
}

export interface SlideSpec {
  title: string;
  body: string;
  images?: Buffer[];
}

function slideXml(index: number, slide: SlideSpec): string {
  const text = (id: number, value: string) =>
    `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="Text ${id}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr/>` +
    `<p:txBody><a:bodyPr/><a:p><a:r><a:t>${value}</a:t></a:r></a:p></p:txBody></p:sp>`;
  const pictures = (slide.images ?? [])
    .map(
      (_, i) =>
        `<p:pic><p:nvPicPr><p:cNvPr id="${10 + i}" name="Picture ${index}.${i + 1}"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr>` +
        `<p:blipFill><a:blip r:embed="rIdImage${i + 1}"/></p:blipFill><p:spPr/></p:pic>`,
    )
    .join("");
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ` +
    `xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ` +
    `xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">` +
    `<p:cSld><p:spTree>${text(2, slide.title)}${text(3, slide.body)}${pictures}</p:spTree></p:cSld></p:sld>`
  );
}

export async function deckPptx(slides: SlideSpec[]): Promise<Buffer> {
  const zip = new JSZip();
  const file = (name: string, data: string | Buffer) => zip.file(name, data, { date: EPOCH });
  const slideTypes = slides
    .map(
      (_, i) =>
        `<Override PartName="/ppt/slides/slide${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`,
    )
    .join("");
  file(
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
      `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
      `<Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/>` +
      `<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>` +
      `${slideTypes}</Types>`,
  );
  file(
    "_rels/.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>` +
      `</Relationships>`,
  );
  const ids = slides.map((_, i) => `<p:sldId id="${256 + i}" r:id="rIdSlide${i + 1}"/>`).join("");
  file(
    "ppt/presentation.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ` +
      `xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ` +
      `xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">` +
      `<p:sldIdLst>${ids}</p:sldIdLst><p:sldSz cx="9144000" cy="6858000"/></p:presentation>`,
  );
  const rels = slides
    .map(
      (_, i) =>
        `<Relationship Id="rIdSlide${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${i + 1}.xml"/>`,
    )
    .join("");
  file(
    "ppt/_rels/presentation.xml.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels}</Relationships>`,
  );
  slides.forEach((slide, i) => {
    file(`ppt/slides/slide${i + 1}.xml`, slideXml(i + 1, slide));
    const images = slide.images ?? [];
    if (images.length === 0) return;
    const imageRels = images
      .map((image, j) => {
        file(`ppt/media/slide${i + 1}-image${j + 1}.png`, image);
        return `<Relationship Id="rIdImage${j + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/slide${i + 1}-image${j + 1}.png"/>`;
      })
      .join("");
    file(
      `ppt/slides/_rels/slide${i + 1}.xml.rels`,
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${imageRels}</Relationships>`,
    );
  });
  return zip.generateAsync({ type: "nodebuffer", compression: "STORE" });
}

function docxImageParagraph(index: number): string {
  const emu = 914400;
  return (
    `<w:p><w:r><w:drawing><wp:inline><wp:extent cx="${emu}" cy="${emu}"/>` +
    `<wp:docPr id="${index}" name="Image ${index}" descr="Image ${index}"/>` +
    `<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">` +
    `<pic:pic><pic:nvPicPr><pic:cNvPr id="${index}" name="image${index}.png"/><pic:cNvPicPr/></pic:nvPicPr>` +
    `<pic:blipFill><a:blip r:embed="rIdImage${index}"/></pic:blipFill>` +
    `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${emu}" cy="${emu}"/></a:xfrm></pic:spPr></pic:pic>` +
    `</a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`
  );
}

export async function imageHeavyDocx(images: Buffer[]): Promise<Buffer> {
  const zip = new JSZip();
  const file = (name: string, data: string | Buffer) => zip.file(name, data, { date: EPOCH });
  file(
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
      `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
      `<Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/>` +
      `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>` +
      `</Types>`,
  );
  file(
    "_rels/.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>` +
      `</Relationships>`,
  );
  const body = images
    .map((_, i) => `<w:p><w:r><w:t>Figure ${i + 1}</w:t></w:r></w:p>${docxImageParagraph(i + 1)}`)
    .join("");
  file(
    "word/document.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ` +
      `xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ` +
      `xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" ` +
      `xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ` +
      `xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">` +
      `<w:body>${body}</w:body></w:document>`,
  );
  const rels = images
    .map(
      (_, i) =>
        `<Relationship Id="rIdImage${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image${i + 1}.png"/>`,
    )
    .join("");
  file(
    "word/_rels/document.xml.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels}</Relationships>`,
  );
  images.forEach((image, i) => file(`word/media/image${i + 1}.png`, image));
  return zip.generateAsync({ type: "nodebuffer", compression: "STORE" });
}

export function pngToRgba8(png: Buffer): { width: number; height: number; data: Buffer } {
  const { width, height, data } = PNG.sync.read(png);
  return { width, height, data };
}

export function alphaRampPng(png: Buffer): Buffer {
  const { width, height, data } = pngToRgba8(png);
  const out = new PNG({ width, height });
  data.copy(out.data);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) out.data[(y * width + x) * 4 + 3] = Math.round((x / (width - 1)) * 255);
  }
  return PNG.sync.write(out);
}

export function solidPng(width: number, height: number, rgb: readonly [number, number, number]): Buffer {
  const png = new PNG({ width, height });
  for (let i = 0; i < png.data.length; i += 4) {
    png.data.set(rgb, i);
    png.data[i + 3] = 255;
  }
  return PNG.sync.write(png);
}

export function tiffFromPng(png: Buffer): Buffer {
  const { width, height, data } = pngToRgba8(png);
  return Buffer.from(UTIF.encodeImage(new Uint8Array(data), width, height));
}

export function fakeMp4(size: number): Buffer {
  const file = Buffer.alloc(size);
  file.writeUInt32BE(24, 0);
  file.write("ftypisom", 4, "latin1");
  file.writeUInt32BE(0x200, 12);
  file.write("isomiso2", 16, "latin1");
  const next = xorshift(7);
  for (let i = 24; i < size; i += 4) file.writeUInt32LE(next(), Math.min(i, size - 4));
  return file;
}

function gifImageData(indices: readonly number[]): number[] {
  const codes: number[] = [];
  for (let i = 0; i < indices.length; i++) {
    if (i % 200 === 0) codes.push(256);
    codes.push(indices[i]!);
  }
  codes.push(257);
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const code of codes) {
    buffer |= code << bits;
    bits += 9;
    while (bits >= 8) {
      bytes.push(buffer & 0xff);
      buffer >>>= 8;
      bits -= 8;
    }
  }
  if (bits > 0) bytes.push(buffer & 0xff);
  const blocks: number[] = [8];
  for (let i = 0; i < bytes.length; i += 255) {
    const slice = bytes.slice(i, i + 255);
    blocks.push(slice.length, ...slice);
  }
  blocks.push(0);
  return blocks;
}

export function gif(
  width: number,
  height: number,
  palette: readonly (readonly number[])[],
  frames: readonly (readonly number[])[],
  { interlaced = false, delayCs = 0 } = {},
): Buffer {
  const table = Array.from({ length: 256 }, (_, i) => palette[i] ?? [0, 0, 0]).flat();
  const header = Buffer.alloc(13);
  header.write("GIF89a", 0, "latin1");
  header.writeUInt16LE(width, 6);
  header.writeUInt16LE(height, 8);
  header[10] = 0x80 | 7;
  const parts: Buffer[] = [header, Buffer.from(table)];
  if (frames.length > 1) parts.push(Buffer.from([0x21, 0xff, 11, ...Buffer.from("NETSCAPE2.0", "latin1"), 3, 1, 0, 0, 0]));
  for (const indices of frames) {
    if (frames.length > 1) parts.push(Buffer.from([0x21, 0xf9, 4, 0, delayCs & 0xff, delayCs >> 8, 0, 0]));
    const descriptor = Buffer.alloc(10);
    descriptor[0] = 0x2c;
    descriptor.writeUInt16LE(width, 5);
    descriptor.writeUInt16LE(height, 7);
    descriptor[9] = interlaced ? 0x40 : 0;
    parts.push(descriptor, Buffer.from(gifImageData(indices)));
  }
  parts.push(Buffer.from([0x3b]));
  return Buffer.concat(parts);
}

// A forecast-style workbook for the inspector, record cards and issue scan: a merged title row above
// the real header, a shared formula group whose last cells were never calculated, error cells and dates.
export async function inspectionWorkbook(): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.created = EPOCH;
  workbook.modified = EPOCH;
  const summary = workbook.addWorksheet("Summary");
  summary.getCell("A1").value = "Forecast 2026";
  summary.mergeCells("A1:F1");
  summary.getRow(2).values = ["Region", "Q1", "Q2", "Total", "Growth", "Updated"];
  const regions = ["North", "South", "East", "West", "Central", "Islands", "Online", "Export"];
  regions.forEach((region, i) => {
    const row = i + 3;
    const q1 = 100 + i * 10;
    const q2 = 120 + i * 10;
    summary.getCell(`A${row}`).value = region;
    summary.getCell(`B${row}`).value = q1;
    summary.getCell(`C${row}`).value = q2;
    const cached = i < 6 ? { result: q1 + q2 } : {};
    summary.getCell(`D${row}`).value = i === 0 ? { formula: "B3+C3", ...cached } : { sharedFormula: "D3", ...cached };
    summary.getCell(`E${row}`).value = q2 / q1 - 1;
    summary.getCell(`E${row}`).numFmt = "0.0%";
    summary.getCell(`F${row}`).value = new Date(Date.UTC(2026, 0, 10 + i));
    summary.getCell(`F${row}`).numFmt = "yyyy-mm-dd";
  });
  summary.getCell("B8").value = { formula: "B7*1.1", result: 165 };
  summary.getCell("B8").numFmt = '"$"#,##0.00';
  summary.getCell("E5").value = { formula: "C5/0", result: { error: "#DIV/0!" } };
  summary.getCell("E7").value = { error: "#REF!" };
  summary.getCell("G3").value = { formula: "SUM(D3:D10)" };
  summary.getCell("G4").value = true;
  const wide = workbook.addWorksheet("Wide");
  wide.addRow(Array.from({ length: 60 }, (_, c) => `Field ${c + 1}`));
  for (let r = 1; r <= 20; r++) wide.addRow(Array.from({ length: 60 }, (_, c) => `r${r}c${c + 1}`));
  return Buffer.from(await workbook.xlsx.writeBuffer());
}
