import type { SearchCursor } from "../shared/search";
import type { DocSearchOutput } from "../shared/rpc";
import { createHmac, randomBytes } from "node:crypto";
import { open, readFile, stat } from "node:fs/promises";
import { basename } from "node:path";
import { DEFAULT_RENDER_WIDTH_PX, MAX_RENDER_EDGE_PX, XLSX_MAX_COLUMNS } from "../shared/limits";
import { KIND_REGISTRY, detectKind, extensionOf, kindForPath, type DocumentKind, type PagedRpc } from "../shared/kinds";
import type {
  DocBlocksOutput,
  DocOpenOutput,
  DocPageOutput,
  DocRowsOutput,
  DocTextOutput,
  DocsRecentInput,
  DocsRecentOutput,
  MediaChunkOutput,
} from "../shared/rpc";
import { estimateBytes, memo } from "./cache";
import { isEncryptedOoxml } from "./cfb";
import { csvRows, csvWindow, indexCsv } from "./csv";
import { blockPage, docxBlocks, docxModelBytes, fitDocxImage, loadDocx, type DocxModel, type SourceBlock } from "./docx";
import { heavy } from "./heavy";
import { animationAsGif, imageAnimation, imageSize, renderImage, type AnimationMimeType, type ImageFamily } from "./images";
import { readChunk, sliceChunk, videoMimeType, audioMimeType } from "./media";
import { resolveInside } from "./paths";
import { pdfPageCount, readPdfPageText, renderPdfPage } from "./pdf";
import { loadDeck, readSlideTexts, renderSlide, type Deck } from "./pptx";
import { IMAGE_BUDGET_BYTES, decodeBudget, type Fit } from "./raster";
import { recentDocuments } from "./recent";
import { SEARCH_BUDGET_MS, SearchScan, parkStream, position, takeStream, type SearchPosition } from "./search";
import { loadSharedStrings, loadWorkbook, rowWindow, sheetRows, type Workbook } from "./xlsx";
import { readZipIndex, verifyEntries, type ZipIndex, type ZipLimits } from "./zip";
import { ERROR_MESSAGES, errorText } from "../shared/errors";

export interface DocumentRef {
  root: string;
  path: string;
  password?: string;
}

interface DocumentFile {
  path: string;
  extension: string;
  kind: DocumentKind;
  size: number;
  revision: string;
  password?: string;
  passwordKey: string;
}

type PageRequest = { index: number; maxWidth?: number };
type TextRequest = { index: number };
type RowsRequest = { sheet: number; rowOffset: number; columnOffset: number; maxColumns?: number; maxRows?: number };
type BlocksRequest = { cursor: number };
type ChunkRequest = { offset: number; length: number; mimeType?: AnimationMimeType };

interface KindHandler {
  open(file: DocumentFile): Promise<DocOpenOutput>;
  page?(file: DocumentFile, request: PageRequest): Promise<DocPageOutput>;
  text?(file: DocumentFile, request: TextRequest): Promise<DocTextOutput>;
  rows?(file: DocumentFile, request: RowsRequest): Promise<DocRowsOutput>;
  blocks?(file: DocumentFile, request: BlocksRequest): Promise<DocBlocksOutput>;
  chunk?(file: DocumentFile, request: ChunkRequest): Promise<MediaChunkOutput>;
}

const MiB = 1024 * 1024;
const MAX_FILE_BYTES: { readonly [K in DocumentKind]: number } = {
  pdf: 512 * MiB,
  docx: 64 * MiB,
  xlsx: 64 * MiB,
  csv: 64 * MiB,
  pptx: 64 * MiB,
  video: Number.POSITIVE_INFINITY,
  audio: Number.POSITIVE_INFINITY,
  "image-raster": 128 * MiB,
  "image-decoded": 128 * MiB,
};
const OFFICE_LIMITS: ZipLimits = { maxEntries: 20_000, maxTotalBytes: 128 * MiB, maxPartBytes: 32 * MiB };
const XLSX_LIMITS: ZipLimits = {
  maxEntries: 100_000,
  maxTotalBytes: 1024 * MiB,
  maxPartBytes: 32 * MiB,
  streamed: (name) => /^xl\/worksheets\/[^/]+\.xml$/.test(name),
};
const DOCX_MAX_MARKUP = 250_000;
const HEAD_BYTES = 32;
const OLE2 = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
const PASSWORD_KEY_SECRET = randomBytes(32);

function passwordKey(password: string | undefined): string {
  return password ? createHmac("sha256", PASSWORD_KEY_SECRET).update(password).digest("base64url") : "";
}

async function readHead(path: string): Promise<Uint8Array> {
  const handle = await open(path, "r");
  try {
    const head = new Uint8Array(HEAD_BYTES);
    const { bytesRead } = await handle.read(head, 0, HEAD_BYTES, 0);
    return head.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

async function locate(ref: DocumentRef): Promise<DocumentFile> {
  const path = await resolveInside(ref.root, ref.path);
  const info = await stat(path);
  if (!info.isFile()) throw new Error(ERROR_MESSAGES.notAFile(ref.path));
  const extension = extensionOf(path);
  const kind = kindForPath(path);
  if (!kind) throw new Error(ERROR_MESSAGES.unsupportedType(extension));
  if (info.size > MAX_FILE_BYTES[kind]) throw new Error(ERROR_MESSAGES.fileTooLarge(info.size, MAX_FILE_BYTES[kind]));
  const head = await readHead(path);
  if (detectKind(path, head) !== kind) {
    if (OLE2.every((byte, i) => head[i] === byte)) {
      throw new Error((await isEncryptedOoxml(path)) ? ERROR_MESSAGES.encryptedOffice() : ERROR_MESSAGES.legacyOffice());
    }
    throw new Error(ERROR_MESSAGES.contentMismatch(extension));
  }
  const stamp = (value: number) => Math.trunc(value * 1000).toString(36);
  const revision = `${info.size.toString(36)}-${stamp(info.mtimeMs)}-${stamp(info.ctimeMs)}`;
  return { path, extension, kind, size: info.size, revision, password: ref.password, passwordKey: passwordKey(ref.password) };
}

const cached = <T>(file: DocumentFile, name: string, compute: () => Promise<T>, sizeOf?: (value: T) => number) =>
  memo({ path: file.path, revision: file.revision, name: `${name}\0${file.passwordKey}` }, compute, sizeOf);

const heavyCached = <T>(file: DocumentFile, name: string, compute: () => Promise<T>, sizeOf?: (value: T) => number) =>
  cached(file, name, () => heavy(compute), sizeOf);

function fitFor(maxWidth: number | undefined): Fit {
  return { maxWidth: Math.min(maxWidth ?? DEFAULT_RENDER_WIDTH_PX, MAX_RENDER_EDGE_PX), maxBytes: IMAGE_BUDGET_BYTES };
}

function inRange(index: number, count: number, noun: string): void {
  if (index >= count) throw new Error(ERROR_MESSAGES.outOfRange(noun, index, count));
}

const indexBytes = (index: ZipIndex) => index.entries.size * 256;

const workbook = (file: DocumentFile) =>
  heavyCached(
    file,
    "workbook",
    async (): Promise<Workbook> => loadWorkbook(await readZipIndex(file.path, file.size, "xlsx", XLSX_LIMITS)),
    (model) => indexBytes(model.index) + estimateBytes(model.sheets),
  );
const sharedStrings = (file: DocumentFile, model: Workbook) =>
  heavyCached(file, "shared-strings", () => loadSharedStrings(model), (strings) =>
    strings.reduce((total, text) => total + 64 + text.length * 2, 0),
  );
const csvIndex = (file: DocumentFile) => heavyCached(file, "csv-index", () => indexCsv(file.path, file.extension));
const deck = (file: DocumentFile) =>
  heavyCached(
    file,
    "deck",
    async (): Promise<Deck> => loadDeck(await readZipIndex(file.path, file.size, "pptx", OFFICE_LIMITS)),
    (model) => indexBytes(model.index) + model.slides.length * 64,
  );
const docx = (file: DocumentFile) =>
  heavyCached(
    file,
    "docx",
    async (): Promise<DocxModel> => {
      const index = await readZipIndex(file.path, file.size, "docx", OFFICE_LIMITS);
      return loadDocx(index, await verifyEntries(index, "docx", DOCX_MAX_MARKUP));
    },
    docxModelBytes,
  );

function imageHandler(kind: "image-raster" | "image-decoded", family: ImageFamily): KindHandler {
  return {
    open: async (file) => ({
      kind,
      revision: file.revision,
      ...(await heavy(async () => {
        const bytes = await readFile(file.path);
        const animation = imageAnimation(bytes, family);
        return { ...(await imageSize(bytes, family)), ...(animation ? { animation } : {}) };
      })),
    }),
    page: async (file, { index, maxWidth }) => {
      inRange(index, 1, "Page");
      const fit = fitFor(maxWidth);
      return heavyCached(file, `image\0${fit.maxWidth}`, async () => {
        const bytes = await readFile(file.path);
        const source = await imageSize(bytes, family);
        const image = await renderImage(bytes, family, fit);
        return { kind, revision: file.revision, sourceWidth: source.width, sourceHeight: source.height, image };
      });
    },
    chunk: async (file, { offset, length, mimeType }) => {
      const opened = await openCached(file);
      const animation = "animation" in opened ? opened.animation : undefined;
      if (!animation) throw new Error(ERROR_MESSAGES.unavailable("media.chunk", "still image"));
      if (!mimeType || mimeType === animation.mimeType) {
        const original = await readChunk(file.path, file.size, offset, length);
        return { kind, revision: file.revision, mimeType: animation.mimeType, offset, size: file.size, ...original };
      }
      if (mimeType !== "image/gif") throw new Error(ERROR_MESSAGES.unavailable(`media.chunk as ${mimeType}`, animation.mimeType));
      const gif = await heavyCached(file, "gif", async () => animationAsGif(await readFile(file.path), family), (bytes) => bytes.length);
      return { kind, revision: file.revision, mimeType, offset, size: gif.length, ...sliceChunk(gif, offset, length) };
    },
  };
}

const HANDLERS: { readonly [K in DocumentKind]: KindHandler } = {
  pdf: {
    open: async (file) => ({ kind: "pdf", revision: file.revision, pageCount: await heavy(() => pdfPageCount(file)) }),
    page: async (file, { index, maxWidth }) => {
      const fit = fitFor(maxWidth);
      const { pageCount, image } = await heavyCached(file, `page\0${index}\0${fit.maxWidth}`, () => renderPdfPage(file, index, fit));
      return { kind: "pdf", revision: file.revision, index, pageCount, image };
    },
    text: async (file, { index }) => ({
      kind: "pdf",
      revision: file.revision,
      index,
      ...(await heavyCached(file, `text\0${index}`, () => readPdfPageText(file, index))),
    }),
  },
  docx: {
    open: async (file) => {
      await docx(file);
      return { kind: "docx", revision: file.revision };
    },
    blocks: async (file, { cursor }) => {
      const model = await docx(file);
      const budget = decodeBudget();
      const page = await blockPage(model, cursor, (id) =>
        heavyCached(file, `docx-image\0${id}`, () => fitDocxImage(model, id, budget)).catch((error: unknown) => errorText(error)),
      );
      return { kind: "docx", revision: file.revision, ...page };
    },
  },
  xlsx: {
    open: async (file) => {
      const model = await workbook(file);
      return {
        kind: "xlsx",
        revision: file.revision,
        sheets: model.sheets.map(({ name, rowCount, columnCount, countsApproximate }) => ({ name, rowCount, columnCount, countsApproximate })),
        sheetsTruncated: model.sheetsTruncated,
      };
    },
    rows: async (file, { sheet, rowOffset, columnOffset, maxColumns, maxRows }) => {
      const model = await workbook(file);
      inRange(sheet, model.sheets.length, "Sheet");
      const strings = await sharedStrings(file, model);
      const columns = Math.min(maxColumns ?? XLSX_MAX_COLUMNS, XLSX_MAX_COLUMNS);
      const rows = Math.min(maxRows ?? 200, 200);
      const window = await heavyCached(file, `rows\0${sheet}\0${rowOffset}\0${columnOffset}\0${columns}\0${rows}`, () =>
        rowWindow(model, strings, model.sheets[sheet], rowOffset, columnOffset, columns, rows),
      );
      return { kind: "xlsx", revision: file.revision, sheet, rowOffset, columnOffset, ...window };
    },
  },
  csv: {
    open: async (file) => {
      const { rowCount, columnCount } = await csvIndex(file);
      return { kind: "csv", revision: file.revision, sheets: [{ name: basename(file.path), rowCount, columnCount, countsApproximate: false }] };
    },
    rows: async (file, { sheet, rowOffset, columnOffset, maxColumns, maxRows }) => {
      inRange(sheet, 1, "Sheet");
      const index = await csvIndex(file);
      const columns = Math.min(maxColumns ?? XLSX_MAX_COLUMNS, XLSX_MAX_COLUMNS);
      const rows = Math.min(maxRows ?? 200, 200);
      const window = await heavyCached(file, `rows\0${rowOffset}\0${columnOffset}\0${columns}\0${rows}`, () =>
        csvWindow(file.path, index, rowOffset, columnOffset, columns, rows),
      );
      return { kind: "csv", revision: file.revision, sheet, rowOffset, columnOffset, ...window };
    },
  },
  pptx: {
    open: async (file) => ({ kind: "pptx", revision: file.revision, slideCount: (await deck(file)).slides.length }),
    page: async (file, { index }) => {
      const slides = await deck(file);
      inRange(index, slides.slides.length, "Slide");
      const slide = await heavyCached(file, `slide\0${index}`, () => renderSlide(slides, index));
      return { kind: "pptx", revision: file.revision, index, slideCount: slides.slides.length, ...slide };
    },
  },
  video: {
    open: async (file) => ({ kind: "video", revision: file.revision, mimeType: videoMimeType(file.extension), size: file.size }),
    chunk: async (file, { offset, length }) => ({
      kind: "video",
      revision: file.revision,
      mimeType: videoMimeType(file.extension),
      offset,
      size: file.size,
      ...(await readChunk(file.path, file.size, offset, length)),
    }),
  },
  audio: {
    open: async (file) => ({ kind: "audio", revision: file.revision, mimeType: audioMimeType(file.extension), size: file.size }),
    chunk: async (file, { offset, length }) => ({
      kind: "audio", revision: file.revision, mimeType: audioMimeType(file.extension), offset, size: file.size,
      ...(await readChunk(file.path, file.size, offset, length)),
    }),
  },
  "image-raster": imageHandler("image-raster", "raster"),
  "image-decoded": imageHandler("image-decoded", "decoded"),
};

function operation<K extends Exclude<keyof KindHandler, "open">>(
  file: DocumentFile,
  rpc: PagedRpc,
  name: K,
): NonNullable<KindHandler[K]> {
  const handler = HANDLERS[file.kind][name];
  if (!KIND_REGISTRY[file.kind].rpcs.includes(rpc) || !handler) {
    throw new Error(ERROR_MESSAGES.unavailable(rpc, file.kind));
  }
  return handler;
}

function openCached(file: DocumentFile): Promise<DocOpenOutput> {
  return cached(file, "open", () => HANDLERS[file.kind].open(file));
}

export async function openDocument(ref: DocumentRef): Promise<DocOpenOutput> {
  return openCached(await locate(ref));
}

export async function renderPage(ref: DocumentRef, request: PageRequest): Promise<DocPageOutput> {
  const file = await locate(ref);
  return operation(file, "doc.page", "page")(file, request);
}

export async function readPageText(ref: DocumentRef, request: TextRequest): Promise<DocTextOutput> {
  const file = await locate(ref);
  return operation(file, "doc.text", "text")(file, request);
}

export async function readRows(ref: DocumentRef, request: RowsRequest): Promise<DocRowsOutput> {
  const file = await locate(ref);
  return operation(file, "doc.rows", "rows")(file, request);
}

export async function readBlocks(ref: DocumentRef, request: BlocksRequest): Promise<DocBlocksOutput> {
  const file = await locate(ref);
  return operation(file, "doc.blocks", "blocks")(file, request);
}

export async function readMediaChunk(ref: DocumentRef, request: ChunkRequest): Promise<MediaChunkOutput> {
  const file = await locate(ref);
  return operation(file, "media.chunk", "chunk")(file, request);
}

export async function listRecent(root: string, request: Omit<DocsRecentInput, "workspaceId">): Promise<DocsRecentOutput> {
  return recentDocuments(root, request);
}

const blockText = (block: SourceBlock) =>
  "text" in block ? block.text
    : block.type === "list" ? block.items.join("\n")
    : block.type === "table" ? block.rows.map((row) => row.join("\t")).join("\n")
    : "";

// Each call scans units in document order until it holds 50 matches or its time budget
// is spent, always making progress. The cursor resumes within a unit, so dense matches are not lost.
export async function searchDocument(ref: DocumentRef, query: string, cursor?: SearchCursor | null, budgetMs = SEARCH_BUDGET_MS): Promise<DocSearchOutput> {
  query = query.trim();
  if (!query || query.length > 200) throw new Error("Enter a search term of 1–200 characters");
  const file = await locate(ref);
  if (cursor && (cursor.revision !== file.revision || cursor.query !== query)) throw new Error("The document or search changed. Search again.");
  const state: SearchCursor = cursor ?? { revision: file.revision, query, sheet: 0, unit: 0, column: 0, offset: 0 };
  const scan = new SearchScan(state, Date.now() + budgetMs);
  const notes = new Set<string>();
  if (file.kind === "pdf") {
    notes.add("Search covers selectable text; scanned pages and outlined text require OCR.");
    const opened = await openCached(file);
    const pageCount = "pageCount" in opened ? opened.pageCount : 0;
    for (let page = state.unit; page < pageCount; page++) {
      await scan.breathe();
      const { text, truncated } = await HANDLERS.pdf.text!(file, { index: page });
      if (truncated) notes.add("Some page text exceeds the extraction limit and was not searched.");
      if (!scan.visit(text, { type: "page", index: page }, position(0, page), position(0, page + 1))) break;
    }
  } else if (file.kind === "pptx") {
    notes.add("Search covers extracted slide text, subject to the viewer's text limits; pictures and notes are excluded.");
    const model = await deck(file);
    for (let slide = state.unit; slide < model.slides.length; slide++) {
      await scan.breathe();
      const texts = await heavy(() => readSlideTexts(model, slide));
      if (!scan.visit(texts.join("\n"), { type: "page", index: slide }, position(0, slide), position(0, slide + 1))) break;
    }
  } else if (file.kind === "docx") {
    notes.add("Search covers the reading view's bounded text; images and footnotes are excluded.");
    const model = await docx(file);
    await heavy(async () => {
      let index = 0;
      for await (const block of docxBlocks(model)) {
        const at = index++;
        if (at < state.unit) continue;
        await scan.breathe();
        if (!scan.visit(blockText(block), { type: "block", index: at }, position(0, at), position(0, at + 1))) break;
      }
    });
  } else if (file.kind === "xlsx" || file.kind === "csv") {
    notes.add("Search covers displayed cell text (up to 2,000 characters per cell); chart text and comments are excluded.");
    const visitRow = (sheet: number, row: number, cells: Iterable<readonly [number, string]>, from: SearchPosition) => {
      for (const [column, text] of cells) {
        if (!text || (row === from.unit && column < from.column)) continue;
        const target = { type: "cell", sheet, row, column } as const;
        if (!scan.visit(text, target, position(sheet, row, column), position(sheet, row, column + 1))) return false;
      }
      return true;
    };
    if (file.kind === "csv") {
      const index = await csvIndex(file);
      if (state.sheet === 0) {
        await heavy(() => csvRows(file.path, index, state.unit, 0, index.columnCount, Number.POSITIVE_INFINITY,
          (row, cells) => visitRow(0, row, cells.entries(), state)));
      }
    } else {
      const model = await workbook(file);
      const strings = await sharedStrings(file, model);
      if (model.sheetsTruncated) notes.add("Sheets beyond the viewer's 500-sheet limit are excluded.");
      await heavy(async () => {
        for (let sheet = state.sheet; sheet < model.sheets.length && !scan.next; sheet++) {
          const from = sheet === state.sheet ? state : position(sheet, 0);
          const key = `${file.path}\0${file.revision}\0${sheet}`;
          const stream = takeStream(key, from.unit, () => sheetRows(model, strings, model.sheets[sheet], from.unit));
          try {
            for await (const { row, cells } of stream.from(from.unit)) {
              await scan.breathe();
              if (cells && !visitRow(sheet, row, [...cells].sort((a, b) => a[0] - b[0]), from)) break;
            }
          } catch (error) {
            stream.close();
            throw error;
          }
          parkStream(key, stream);
        }
      });
    }
  } else throw new Error("Find is available for PDF, Word, spreadsheets and PowerPoint");

  // Reject an interleaved rewrite instead of attaching stale matches to a new revision.
  if ((await locate(ref)).revision !== file.revision) throw new Error("The document changed while searching. Search again.");
  return { revision: file.revision, matches: scan.matches, next: scan.next, notes: [...notes], scanned: scan.scanned };
}
