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
