import type { SearchCursor, SearchMatch } from "../shared/search";
import type { CellDetail, DocCellOutput, DocIssuesOutput, DocSearchOutput } from "../shared/rpc";
import { createHmac, randomBytes } from "node:crypto";
import { open, readFile, stat } from "node:fs/promises";
import { basename } from "node:path";
import { CELL_FULL_MAX_CHARS, DEFAULT_RENDER_WIDTH_PX, MAX_RENDER_EDGE_PX, REVIEW_IMAGE_MAX_BASE64_CHARS, REVIEW_IMAGE_MAX_EDGE_PX, THUMBNAIL_MAX_WIDTH_PX, XLSX_MAX_CELL_CHARS, XLSX_MAX_COLUMNS } from "../shared/limits";
import type { ReviewStatus } from "../shared/browse";
import { KIND_REGISTRY, detectKind, extensionOf, kindForPath, type DocumentKind, type PagedRpc } from "../shared/kinds";
import type {
  DocBlocksOutput,
  DocOpenOutput,
  DocPageOutput,
  ReviewPageImageOutput,
  DocRowsOutput,
  DocTextOutput,
  DocThumbnailOutput,
  DocsRecentInput,
  DocsRecentOutput,
  MediaChunkOutput,
} from "../shared/rpc";
import { estimateBytes, memo } from "./cache";
import { isEncryptedOoxml } from "./cfb";
import { csvFullCell, csvRows, csvWindow, indexCsv } from "./csv";
import { recordCells, type FullValue } from "./data-table";
import { indexJsonl, jsonlFullValue, jsonlRecords, jsonlWindow } from "./jsonl";
import { openParquet, parquetFullValue, parquetModelBytes, parquetRecords, parquetWindow } from "./parquet";
import { blockPage, docxBlocks, docxModelBytes, fitDocxImage, loadDocx, type DocxModel, type SourceBlock } from "./docx";
import { heavy } from "./heavy";
import { animationAsGif, imageAnimation, imageSize, renderImage, type AnimationMimeType, type ImageFamily } from "./images";
import { readChunk, sliceChunk, videoMimeType, audioMimeType } from "./media";
import { resolveInside } from "./paths";
import { pdfPageCount, readPdfPageText, renderPdfPage, searchPdfPage } from "./pdf";
import { loadDeck, readSlideTexts, renderSlide, type Deck } from "./pptx";
import { IMAGE_BUDGET_BYTES, base64Capacity, decodeBudget, type Fit } from "./raster";
import { recentDocuments, type RecentEntry } from "./recent";
import { revisionOf } from "./revision";
import { viewerStateStore } from "./viewer-state";
import { SEARCH_BUDGET_MS, SearchScan, matchingSharedStrings, parkStream, position, takeStream, type SearchPosition } from "./search";
import { SharedFormulas } from "./formulas";
import { fullCellText, issueDecoder, loadSharedStrings, loadWorkbook, rowWindow, sheetRows, textDecoder, type Workbook } from "./xlsx";
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
type ThumbnailRequest = { index: number; width: number };
type TextRequest = { index: number };
type RowsRequest = { sheet: number; rowOffset: number; columnOffset: number; maxColumns?: number; maxRows?: number; detail?: boolean };
type BlocksRequest = { cursor: number };
type CellRequest = { sheet: number; row: number; column: number | null };
type ChunkRequest = { offset: number; length: number; mimeType?: AnimationMimeType };

interface KindHandler {
  open(file: DocumentFile): Promise<DocOpenOutput>;
  page?(file: DocumentFile, request: PageRequest): Promise<DocPageOutput>;
  thumbnail?(file: DocumentFile, request: ThumbnailRequest): Promise<DocThumbnailOutput>;
  text?(file: DocumentFile, request: TextRequest): Promise<DocTextOutput>;
  rows?(file: DocumentFile, request: RowsRequest): Promise<DocRowsOutput>;
  cell?(file: DocumentFile, request: CellRequest): Promise<FullValue & { line?: number }>;
  blocks?(file: DocumentFile, request: BlocksRequest): Promise<DocBlocksOutput>;
  chunk?(file: DocumentFile, request: ChunkRequest): Promise<MediaChunkOutput>;
}

const MiB = 1024 * 1024;
const MAX_FILE_BYTES: { readonly [K in DocumentKind]: number } = {
  pdf: 512 * MiB,
  docx: 64 * MiB,
  xlsx: 64 * MiB,
  csv: 64 * MiB,
  jsonl: 512 * MiB,
  parquet: 2048 * MiB,
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
const THUMBNAIL_MAX_BYTES = 256 * 1024;
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
  return { path, extension, kind, size: info.size, revision: revisionOf(info), password: ref.password, passwordKey: passwordKey(ref.password) };
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
const parquetModel = (file: DocumentFile) => heavyCached(file, "parquet", () => openParquet(file.path, file.size), parquetModelBytes);
const jsonlIndex = (file: DocumentFile) =>
  heavyCached(file, "jsonl-index", () => indexJsonl(file.path), (index) =>
    index.checkpoints.length * 48 + index.issues.length * 160 + index.columns.reduce((total, path) => total + 64 + path.join(".").length * 2, 0));
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

// Workbook text is cut at XLSX_MAX_CELL_CHARS when it is read, so a value at that length may be longer in the file.
function markCut(details: (CellDetail | null)[][]): (CellDetail | null)[][] {
  return details.map((row) => row.map((detail) =>
    detail && ((detail.raw?.length ?? 0) >= XLSX_MAX_CELL_CHARS || detail.display.length >= XLSX_MAX_CELL_CHARS) ? { ...detail, truncated: true } : detail));
}

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
    // Thumbnails skip the shared cache so a grid cannot evict the pages being read; the client keeps them.
    thumbnail: async (file, { index, width }) => {
      const fit = { maxWidth: Math.min(width, THUMBNAIL_MAX_WIDTH_PX), maxBytes: THUMBNAIL_MAX_BYTES };
      const { pageCount, image } = await heavy(() => renderPdfPage(file, index, fit), { background: true });
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
    rows: async (file, { sheet, rowOffset, columnOffset, maxColumns, maxRows, detail = false }) => {
      const model = await workbook(file);
      inRange(sheet, model.sheets.length, "Sheet");
      const strings = await sharedStrings(file, model);
      const columns = Math.min(maxColumns ?? XLSX_MAX_COLUMNS, XLSX_MAX_COLUMNS);
      const rows = Math.min(maxRows ?? 200, 200);
      const window = await heavyCached(file, `rows\0${sheet}\0${rowOffset}\0${columnOffset}\0${columns}\0${rows}\0${detail}`, () =>
        rowWindow(model, strings, model.sheets[sheet], rowOffset, columnOffset, columns, rows, detail),
      );
      return { kind: "xlsx", revision: file.revision, sheet, rowOffset, columnOffset, ...window, ...(window.details ? { details: markCut(window.details) } : {}) };
    },
    cell: async (file, { sheet, row, column }) => {
      const model = await workbook(file);
      inRange(sheet, model.sheets.length, "Sheet");
      if (column === null) throw new Error(ERROR_MESSAGES.unavailable("doc.cell for a whole row", "xlsx"));
      const strings = await sharedStrings(file, model);
      const found = await heavy(() => fullCellText(model, strings, model.sheets[sheet]!, row, column, CELL_FULL_MAX_CHARS, Date.now() + 18_000));
      return { format: "text", ...(found ?? { text: "", truncated: false, length: 0 }) };
    },
  },
  csv: {
    open: async (file) => {
      const { rowCount, columnCount } = await csvIndex(file);
      return { kind: "csv", revision: file.revision, sheets: [{ name: basename(file.path), rowCount, columnCount, countsApproximate: false }] };
    },
    rows: async (file, { sheet, rowOffset, columnOffset, maxColumns, maxRows, detail = false }) => {
      inRange(sheet, 1, "Sheet");
      const index = await csvIndex(file);
      const columns = Math.min(maxColumns ?? XLSX_MAX_COLUMNS, XLSX_MAX_COLUMNS);
      const rows = Math.min(maxRows ?? 200, 200);
      const window = await heavyCached(file, `rows\0${rowOffset}\0${columnOffset}\0${columns}\0${rows}\0${detail}`, () =>
        csvWindow(file.path, index, rowOffset, columnOffset, columns, rows, detail),
      );
      return { kind: "csv", revision: file.revision, sheet, rowOffset, columnOffset, ...window };
    },
    cell: async (file, { sheet, row, column }) => {
      inRange(sheet, 1, "Sheet");
      if (column === null) throw new Error(ERROR_MESSAGES.unavailable("doc.cell for a whole row", "csv"));
      const index = await csvIndex(file);
      if (row >= index.rowCount) throw new Error(ERROR_MESSAGES.outOfRange("Row", row, index.rowCount));
      return { format: "text", ...(await heavy(() => csvFullCell(file.path, index, row, column))) };
    },
  },
  jsonl: {
    open: async (file) => {
      const { rowCount, columns } = await jsonlIndex(file);
      return { kind: "jsonl", revision: file.revision, sheets: [{ name: basename(file.path), rowCount, columnCount: columns.length, countsApproximate: false }] };
    },
    rows: async (file, { sheet, rowOffset, columnOffset, maxColumns, maxRows, detail = false }) => {
      inRange(sheet, 1, "Sheet");
      const index = await jsonlIndex(file);
      const columns = Math.min(maxColumns ?? XLSX_MAX_COLUMNS, XLSX_MAX_COLUMNS);
      const rows = Math.min(maxRows ?? 200, 200);
      const window = await heavyCached(file, `rows\0${rowOffset}\0${columnOffset}\0${columns}\0${rows}\0${detail}`, () =>
        jsonlWindow(file.path, index, rowOffset, columnOffset, columns, rows, detail),
      );
      return { kind: "jsonl", revision: file.revision, sheet, rowOffset, columnOffset, ...window };
    },
    cell: async (file, { sheet, row, column }) => {
      inRange(sheet, 1, "Sheet");
      const index = await jsonlIndex(file);
      return heavy(() => jsonlFullValue(file.path, index, row, column));
    },
  },
  parquet: {
    open: async (file) => {
      const { rowCount, columns } = await parquetModel(file);
      return { kind: "parquet", revision: file.revision, sheets: [{ name: basename(file.path), rowCount, columnCount: columns.length, countsApproximate: false }] };
    },
    rows: async (file, { sheet, rowOffset, columnOffset, maxColumns, maxRows, detail = false }) => {
      inRange(sheet, 1, "Sheet");
      const model = await parquetModel(file);
      const columns = Math.min(maxColumns ?? XLSX_MAX_COLUMNS, XLSX_MAX_COLUMNS);
      const rows = Math.min(maxRows ?? 200, 200);
      const window = await heavyCached(file, `rows\0${rowOffset}\0${columnOffset}\0${columns}\0${rows}\0${detail}`, () =>
        parquetWindow(file.path, file.size, model, rowOffset, columnOffset, columns, rows, detail),
      );
      return { kind: "parquet", revision: file.revision, sheet, rowOffset, columnOffset, ...window };
    },
    cell: async (file, { sheet, row, column }) => {
      inRange(sheet, 1, "Sheet");
      const model = await parquetModel(file);
      return heavy(() => parquetFullValue(file.path, file.size, model, row, column));
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

export async function renderThumbnail(ref: DocumentRef, request: ThumbnailRequest): Promise<DocThumbnailOutput> {
  const file = await locate(ref);
  return operation(file, "doc.thumbnail", "thumbnail")(file, request);
}

const REVIEW_FIT: Fit = {
  maxWidth: REVIEW_IMAGE_MAX_EDGE_PX,
  maxEdge: REVIEW_IMAGE_MAX_EDGE_PX,
  maxBytes: base64Capacity(REVIEW_IMAGE_MAX_BASE64_CHARS),
};

// Renders the page a review note refers to, but only while the file is still at the note's
// revision: an image of a later rewrite must not be attached to an older note.
export async function renderReviewPage(ref: DocumentRef, { index, revision }: { index: number; revision: string }): Promise<ReviewPageImageOutput> {
  const file = await locate(ref);
  if (file.kind !== "pdf") throw new Error(ERROR_MESSAGES.unavailable("review.page-image", file.kind));
  if (file.revision !== revision) throw new Error(ERROR_MESSAGES.revisionChanged());
  const { image } = await heavyCached(file, `review-page\0${index}`, () => renderPdfPage(file, index, REVIEW_FIT));
  return { revision, index, image };
}

export async function readPageText(ref: DocumentRef, request: TextRequest): Promise<DocTextOutput> {
  const file = await locate(ref);
  return operation(file, "doc.text", "text")(file, request);
}

export async function readRows(ref: DocumentRef, request: RowsRequest): Promise<DocRowsOutput> {
  const file = await locate(ref);
  return operation(file, "doc.rows", "rows")(file, request);
}

export async function readCell(ref: DocumentRef, request: CellRequest): Promise<DocCellOutput> {
  const file = await locate(ref);
  return { revision: file.revision, ...(await operation(file, "doc.cell", "cell")(file, request)) };
}

export async function readBlocks(ref: DocumentRef, request: BlocksRequest): Promise<DocBlocksOutput> {
  const file = await locate(ref);
  return operation(file, "doc.blocks", "blocks")(file, request);
}

export async function readMediaChunk(ref: DocumentRef, request: ChunkRequest): Promise<MediaChunkOutput> {
  const file = await locate(ref);
  return operation(file, "media.chunk", "chunk")(file, request);
}

// Review status is computed only when some document has been marked reviewed.
export async function listRecent(root: string, request: Omit<DocsRecentInput, "workspaceId">, store = viewerStateStore): Promise<DocsRecentOutput> {
  const reviewed = await store.reviewedRevisions();
  const keyOf = reviewed.size > 0 ? await store.scannedKeys(root) : null;
  const status = (entry: RecentEntry): ReviewStatus | undefined => {
    const revision = keyOf ? reviewed.get(keyOf(entry.path)) : undefined;
    return revision === undefined ? undefined : revision === entry.revision ? "reviewed" : "changed";
  };
  const listed = await recentDocuments(root, request, keyOf ? status : undefined);
  return {
    ...listed,
    entries: listed.entries.map(({ path, kind, mtimeMs, size, review, isNew }) => ({
      path, kind, mtimeMs, size, ...(review ? { review } : {}), ...(isNew ? { isNew: true as const } : {}),
    })),
  };
}

const blockText = (block: SourceBlock) =>
  "text" in block ? block.text
    : block.type === "list" ? block.items.join("\n")
    : block.type === "table" ? block.rows.map((row) => row.join("\t")).join("\n")
    : "";

// Each call scans units in document order until it holds 50 matches or its time budget
// is spent, always making progress. The cursor resumes within a unit, so dense matches are not lost.
export async function searchDocument(ref: DocumentRef, query: string, cursor?: SearchCursor | null, budgetMs = SEARCH_BUDGET_MS, current?: () => boolean): Promise<DocSearchOutput> {
  query = query.trim();
  if (!query || query.length > 200) throw new Error("Enter a search term of 1–200 characters");
  const file = await locate(ref);
  if (cursor && (cursor.revision !== file.revision || cursor.query !== query)) throw new Error("The document or search changed. Search again.");
  const state: SearchCursor = cursor ?? { revision: file.revision, query, sheet: 0, unit: 0, column: 0, offset: 0 };
  const scan = new SearchScan(state, Date.now() + budgetMs, current);
  scan.checkCurrent();
  const notes = new Set<string>();
  if (file.kind === "pdf") {
    notes.add("Search covers selectable text; scanned pages and outlined text require OCR.");
    const opened = await openCached(file);
    const pageCount = "pageCount" in opened ? opened.pageCount : 0;
    for (let page = state.unit; page < pageCount; page++) {
      await scan.breathe();
      const result = await searchPdfPage(file, page, query);
      if (result.truncated) notes.add("Some page text exceeds the extraction limit and was not searched.");
      const found: SearchMatch[] = result.matches.map((match) => ({
        target: { type: "page", index: page },
        start: match.start,
        length: match.count,
        snippet: match.snippet,
        boxes: match.boxes,
      }));
      if (!scan.visitMatches(found, position(0, page), position(0, page + 1))) break;
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
    notes.add("Search covers the document text shown here; text inside images and footnotes is not searched.");
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
      const sharedMatches = matchingSharedStrings(strings, query);
      await heavy(async () => {
        for (let sheet = state.sheet; sheet < model.sheets.length && !scan.next; sheet++) {
          const from = sheet === state.sheet ? state : position(sheet, 0);
          const key = `${file.path}\0${file.revision}\0${sheet}\0${query}`;
          const stream = takeStream(key, from.unit, () => sheetRows(model, model.sheets[sheet], from.unit, { decode: textDecoder(model, strings, sharedMatches) }));
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
  } else if (file.kind === "jsonl") {
    notes.add("Search covers displayed cell text (up to 2,000 characters per cell) in the listed columns.");
    const index = await jsonlIndex(file);
    const columns = index.columns;
    if (state.sheet === 0) {
      await heavy(() => jsonlRecords(file.path, index, state.unit, Number.POSITIVE_INFINITY, (row, record) => {
        const { cells } = recordCells(record, columns, false);
        for (let column = row === state.unit ? state.column : 0; column < cells.length; column++) {
          const text = cells[column];
          if (!text) continue;
          if (!scan.visit(text, { type: "cell", sheet: 0, row, column }, position(0, row, column), position(0, row, column + 1))) return false;
        }
        return true;
      }));
    }
  } else if (file.kind === "parquet") {
    notes.add("Search covers displayed cell text (up to 2,000 characters per cell) in the listed columns.");
    const model = await parquetModel(file);
    const columns = model.columns.map((column) => column.path);
    if (state.sheet === 0) {
      await heavy(() => parquetRecords(file.path, file.size, model, state.unit, (row, value) => {
        const { cells } = recordCells({ value }, columns, false);
        for (let column = row === state.unit ? state.column : 0; column < cells.length; column++) {
          const text = cells[column];
          if (!text) continue;
          if (!scan.visit(text, { type: "cell", sheet: 0, row, column }, position(0, row, column), position(0, row, column + 1))) return false;
        }
        return true;
      }, () => scan.breathe()));
    }
  } else throw new Error("Find is available for PDF, Word, spreadsheets, data files and PowerPoint");

  // Reject an interleaved rewrite instead of attaching stale matches to a new revision.
  if ((await locate(ref)).revision !== file.revision) throw new Error("The document changed while searching. Search again.");
  return { revision: file.revision, matches: scan.matches, next: scan.next, notes: [...notes], scanned: scan.scanned };
}

export interface IssueLimits {
  budgetMs: number;
  maxRows: number;
  maxIssues: number;
}

const ISSUE_LIMITS: IssueLimits = { budgetMs: 3_000, maxRows: 250_000, maxIssues: 200 };
const ISSUE_YIELD_MS = 40;

type IssueCursor = NonNullable<DocIssuesOutput["next"]>;

// Each call inspects rows in order until a limit is reached, always making progress; rows before the
// cursor are only tokenized, and a parked stream lets the next call continue without re-reading them.
export async function scanIssues(ref: DocumentRef, cursor?: IssueCursor | null, limits = ISSUE_LIMITS): Promise<DocIssuesOutput> {
  const file = await locate(ref);
  if (file.kind === "jsonl") {
    const index = await jsonlIndex(file);
    return {
      revision: file.revision,
      issues: index.issues.map(({ row, line, kind, message }) => ({ sheet: 0, row, column: 0, kind, display: message, formula: null, line })),
      inspected: [{ sheet: 0, fromRow: 0, toRow: index.rowCount }],
      next: null,
      stopped: null,
      ...(index.omittedIssues > 0 ? { omitted: index.omittedIssues } : {}),
    };
  }
  if (file.kind !== "xlsx") throw new Error("Checking for issues is available for Excel workbooks and JSON Lines files");
  if (cursor && cursor.revision !== file.revision) throw new Error("The workbook changed. Check again.");
  const model = await workbook(file);
  const strings = await sharedStrings(file, model);
  const start = cursor ?? { revision: file.revision, sheet: 0, row: 0, column: 0 };
  const result: DocIssuesOutput = { revision: file.revision, issues: [], inspected: [], next: null, stopped: null };
  const deadline = Date.now() + limits.budgetMs;
  let yielded = Date.now();
  let rows = 0;
  const limit = (): DocIssuesOutput["stopped"] =>
    result.issues.length >= limits.maxIssues ? "issues" : rows >= limits.maxRows ? "rows" : rows > 0 && Date.now() >= deadline ? "time" : null;
  const stop = (reason: NonNullable<DocIssuesOutput["stopped"]>, sheet: number, row: number, column: number) => {
    result.stopped = reason;
    result.next = { revision: file.revision, sheet, row, column };
  };
  await heavy(async () => {
    for (let sheet = start.sheet; sheet < model.sheets.length && !result.stopped; sheet++) {
      const resumed = sheet === start.sheet;
      const from = resumed ? start.row : 0;
      const reason = limit();
      if (reason) {
        stop(reason, sheet, from, resumed ? start.column : 0);
        break;
      }
      const key = `issues\0${file.path}\0${file.revision}\0${sheet}`;
      const stream = takeStream(key, from, () => {
        const formulas = new SharedFormulas();
        return sheetRows(model, model.sheets[sheet]!, from, { decode: issueDecoder(model, strings, formulas), formulas });
      });
      let visited = false;
      let end = from;
      try {
        rowLoop: for await (const { row, cells } of stream.from(from)) {
          if (Date.now() - yielded >= ISSUE_YIELD_MS) {
            await new Promise((resume) => setImmediate(resume));
            yielded = Date.now();
          }
          const before = limit();
          if (before) {
            stop(before, sheet, row, 0);
            break;
          }
          visited = true;
          rows++;
          const skip = resumed && row === start.row ? start.column : 0;
          for (const [column, detail] of [...(cells ?? [])].sort((a, b) => a[0] - b[0])) {
            if (column < skip) continue;
            if (result.issues.length >= limits.maxIssues) {
              stop("issues", sheet, row, column);
              break rowLoop;
            }
            result.issues.push({ sheet, row, column, kind: detail.type === "e" ? "error" : "missing-result", display: detail.display, formula: detail.formula?.text ?? null });
          }
          end = row + 1;
        }
      } catch (error) {
        stream.close();
        throw error;
      }
      if (result.stopped) parkStream(key, stream);
      else {
        stream.close();
        end = Math.max(end, model.sheets[sheet]!.rowCount);
      }
      if (visited || !result.stopped) result.inspected.push({ sheet, fromRow: from, toRow: result.stopped ? result.next!.row : end });
    }
  });
  if ((await locate(ref)).revision !== file.revision) throw new Error("The workbook changed while checking. Check again.");
  return result;
}
