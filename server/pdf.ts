import { readFile } from "node:fs/promises";
import { PDFiumLibrary, type PDFiumDocument } from "@hyzyla/pdfium/inline";
import { fitRendered, type EncodedImage, type Fit } from "./raster";
import { ERROR_MESSAGES } from "../shared/errors";

export interface PdfFile {
  path: string;
  revision: string;
  size: number;
}

interface Held {
  path: string;
  bytes: number;
  document: Promise<PDFiumDocument>;
  users: number;
  evicted: boolean;
}

const MAX_HELD_DOCUMENTS = 4;
const MAX_HELD_BYTES = 256 * 1024 * 1024;
const CERTIFICATE_SECURITY = "/Adobe.PubSec";

let library: Promise<PDFiumLibrary> | undefined;
const held = new Map<string, Held>();

function pdfium(): Promise<PDFiumLibrary> {
  library ??= PDFiumLibrary.init({ disableBase64Warning: true }).catch((error) => {
    library = undefined;
    throw error;
  });
  return library;
}

function loadError(error: unknown, bytes: Buffer): Error {
  const message = error instanceof Error ? error.message : String(error);
  if (/password|security/i.test(message)) {
    if (bytes.includes(CERTIFICATE_SECURITY)) {
      return new Error(ERROR_MESSAGES.pdfCertificateSecurity());
    }
    if (/password/i.test(message)) return new Error(ERROR_MESSAGES.pdfEncrypted());
    return new Error(ERROR_MESSAGES.pdfUnsupportedSecurity());
  }
  console.error("[doc-viewer] PDF load failed:", error);
  return new Error(ERROR_MESSAGES.pdfDamaged());
}

async function load(path: string): Promise<PDFiumDocument> {
  const lib = await pdfium();
  const bytes = await readFile(path);
  try {
    return await lib.loadDocument(bytes);
  } catch (error) {
    throw loadError(error, bytes);
  }
}

function release(entry: Held): void {
  if (entry.evicted && entry.users === 0) entry.document.then((document) => document.destroy(), () => {});
}

function evict(key: string, entry: Held): void {
  if (held.get(key) !== entry) return;
  held.delete(key);
  entry.evicted = true;
  release(entry);
}

function trim(keep: string): void {
  let total = 0;
  for (const entry of held.values()) total += entry.bytes;
  for (const [key, entry] of held) {
    if (total <= MAX_HELD_BYTES && held.size <= MAX_HELD_DOCUMENTS) return;
    if (key === keep) continue;
    total -= entry.bytes;
    evict(key, entry);
  }
}

async function withDocument<T>(file: PdfFile, use: (document: PDFiumDocument) => Promise<T>): Promise<T> {
  const key = `${file.path}\0${file.revision}`;
  let entry = held.get(key);
  if (entry) {
    held.delete(key);
    held.set(key, entry);
  } else {
    for (const [other, candidate] of held) if (candidate.path === file.path) evict(other, candidate);
    const created: Held = { path: file.path, bytes: file.size, document: load(file.path), users: 0, evicted: false };
    created.document.catch(() => evict(key, created));
    held.set(key, created);
    trim(key);
    entry = created;
  }
  entry.users++;
  try {
    return await use(await entry.document);
  } finally {
    entry.users--;
    release(entry);
  }
}

export function pdfPageCount(file: PdfFile): Promise<number> {
  return withDocument(file, async (document) => document.getPageCount());
}

export function renderPdfPage(file: PdfFile, index: number, fit: Fit): Promise<{ pageCount: number; image: EncodedImage }> {
  return withDocument(file, async (document) => {
    const pageCount = document.getPageCount();
    if (index >= pageCount) throw new Error(ERROR_MESSAGES.outOfRange("Page", index, pageCount));
    const page = document.getPage(index);
    try {
      const { originalWidth, originalHeight } = page.getOriginalSize();
      const image = await fitRendered(
        { width: originalWidth, height: originalHeight },
        async (width, height) => page.render({ width, height, scale: 1, render: "bitmap", colorSpace: "RGBA" }),
        fit,
      );
      return { pageCount, image };
    } finally {
      page.close();
    }
  });
}
