import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import mammoth from "mammoth";
import { DEFAULT_RENDER_WIDTH_PX, DOCX_MAX_BLOCKS, MAX_RESPONSE_BYTES, XLSX_MAX_CELL_CHARS } from "../shared/limits";
import type { DocBlock } from "../shared/rpc";
import { descendants, parseHtml, textOf, type Element } from "./html";
import { mainDocumentPart, readDocxLayout, relationships, streamDocxBlocks, type DocxLayout } from "./docx-stream";
import { embeddedImage } from "./images";
import { IMAGE_BUDGET_BYTES, type DecodeBudget, type EncodedImage } from "./raster";
import { readEntry, verifyEntries, type ZipIndex, type ZipMarkup } from "./zip";
import { ERROR_MESSAGES } from "../shared/errors";

export type SourceBlock = Exclude<DocBlock, { type: "image" | "omitted-image" }> | { type: "source-image"; alt: string; id: number };

export type DocxModel =
  | { kind: "converted"; blocks: SourceBlock[]; images: Buffer[] }
  | { kind: "streamed"; index: ZipIndex; layout: DocxLayout };

export interface BlockPage {
  blocks: DocBlock[];
  nextCursor: number | null;
}

const PAGE_BUDGET_BYTES = MAX_RESPONSE_BYTES - 64 * 1024;
const CONVERT_MAX_TAGS = 20_000;
const CONVERT_MAX_XML_BYTES = 2 * 1024 * 1024;
const BLOCK_BUDGET_BYTES = Math.floor(PAGE_BUDGET_BYTES / 2);
const MAX_ALT_CHARS = 1000;
const HEADING = /^h([1-6])$/;
const IMAGE_SOURCE = /^image:(\d+)$/;
const BINARY_RELATIONSHIP = /\/(image|oleObject|package|video|audio|media|vbaProject|printerSettings|font)$/;
const MiB = 1024 * 1024;

const bytesOf = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");
const isList = (element: Element) => element.tag === "ul" || element.tag === "ol";
const clipCell = (text: string) => text.slice(0, XLSX_MAX_CELL_CHARS);

function bounded(block: SourceBlock): SourceBlock {
  if (bytesOf(block) <= BLOCK_BUDGET_BYTES) return block;
  const keep = <T>(items: T[]) => {
    const kept: T[] = [];
    let bytes = 0;
    for (const item of items) {
      bytes += bytesOf(item) + 1;
      if (bytes > BLOCK_BUDGET_BYTES) break;
      kept.push(item);
    }
    return kept;
  };
  switch (block.type) {
    case "heading":
    case "paragraph":
      return { ...block, text: block.text.slice(0, Math.floor(BLOCK_BUDGET_BYTES / 8)) };
    case "list":
      return { ...block, items: keep(block.items) };
    case "table":
      return { ...block, rows: keep(block.rows) };
    default:
      return block;
  }
}

function imagesIn(element: Element): SourceBlock[] {
  const images = element.tag === "img" ? [element] : descendants(element, (child) => child.tag === "img");
  return images.flatMap((image) => {
    const id = IMAGE_SOURCE.exec(image.attributes.src ?? "");
    return id ? [{ type: "source-image" as const, alt: (image.attributes.alt ?? "").slice(0, MAX_ALT_CHARS), id: Number(id[1]) }] : [];
  });
}

function listItems(list: Element, depth: number): string[] {
  return list.children.flatMap((item) => {
    if (typeof item === "string" || item.tag !== "li") return [];
    const own = textOf(item, isList).trim();
    const nested = descendants(item, isList).flatMap((child) => listItems(child, depth + 1));
    return [...(own ? ["  ".repeat(depth) + own] : []), ...nested];
  });
}

function blocksOf(element: Element): SourceBlock[] {
  const heading = HEADING.exec(element.tag);
  if (heading) {
    const text = textOf(element);
    return [...(text.trim() ? [{ type: "heading" as const, level: Number(heading[1]), text }] : []), ...imagesIn(element)];
  }
  if (isList(element)) {
    const items = listItems(element, 0);
    return items.length ? [{ type: "list", ordered: element.tag === "ol", items }] : [];
  }
  if (element.tag === "table") {
    const rows = descendants(element, (child) => child.tag === "tr").map((row) =>
      descendants(row, (cell) => cell.tag === "td" || cell.tag === "th").map((cell) =>
        clipCell(
          descendants(cell, (child) => child.tag === "p").map((paragraph) => textOf(paragraph)).join("\n") || textOf(cell),
        ),
      ),
    );
    return rows.length ? [{ type: "table", rows }] : [];
  }
  const text = textOf(element);
  return [...(text.trim() ? [{ type: "paragraph" as const, text }] : []), ...imagesIn(element)];
}

// Mammoth and the streaming reader parse the main document and the parts it relates to as XML,
// whatever they are named, so their tags and sizes count against the limits too.
export async function verifyDocx(index: ZipIndex, maxMarkup: number, maxPartBytes: number): Promise<ZipMarkup> {
  const main = await mainDocumentPart(index);
  const related = [...(await relationships(index, main)).values()].filter((rel) => !BINARY_RELATIONSHIP.test(rel.type));
  const parts = new Set([main, ...related.map((rel) => rel.target)]);
  for (const name of parts) {
    const size = index.entries.get(name)?.size ?? 0;
    if (size > maxPartBytes) {
      throw new Error(ERROR_MESSAGES.archiveTooLarge(`${name} is ${Math.round(size / MiB)} MiB (the limit is ${maxPartBytes / MiB} MiB)`));
    }
  }
  return verifyEntries(index, "docx", maxMarkup, parts);
}

export async function loadDocx(index: ZipIndex, markup: ZipMarkup): Promise<DocxModel> {
  if (markup.tags <= CONVERT_MAX_TAGS && markup.xmlBytes <= CONVERT_MAX_XML_BYTES) return convertDocx(await readFile(index.path));
  return streamDocx(index);
}

export async function streamDocx(index: ZipIndex): Promise<DocxModel> {
  return { kind: "streamed", index, layout: await readDocxLayout(index) };
}

export async function* docxBlocks(model: DocxModel): AsyncGenerator<SourceBlock> {
  if (model.kind === "converted") yield* model.blocks;
  else for await (const block of streamDocxBlocks(model.index, model.layout, BLOCK_BUDGET_BYTES)) yield bounded(block);
}

export async function docxImage(model: DocxModel, id: number): Promise<Buffer> {
  if (model.kind === "converted") return model.images[id];
  const image = await readEntry(model.index, model.layout.imageParts[id], "docx");
  if (!image) throw new Error(ERROR_MESSAGES.invalidOffice("docx"));
  return image;
}

export async function convertDocx(bytes: Buffer): Promise<DocxModel> {
  const images: Buffer[] = [];
  const ids = new Map<string, number>();
  const convertImage = mammoth.images.imgElement(async (image) => {
    const data = await image.readAsBuffer();
    const hash = createHash("sha1").update(data).digest("hex");
    let id = ids.get(hash);
    if (id === undefined) {
      id = images.push(data) - 1;
      ids.set(hash, id);
    }
    return { src: `image:${id}` };
  });
  let html: string;
  try {
    html = (await mammoth.convertToHtml({ buffer: bytes }, { convertImage, externalFileAccess: false })).value;
  } catch (error) {
    console.error("[doc-viewer] docx conversion failed:", error);
    throw new Error(ERROR_MESSAGES.invalidOffice("docx"));
  }
  const blocks = parseHtml(html).children.flatMap((node): SourceBlock[] => {
    if (typeof node !== "string") return blocksOf(node).map(bounded);
    return node.trim() ? [bounded({ type: "paragraph", text: node })] : [];
  });
  return { kind: "converted", blocks, images };
}

export function docxModelBytes(model: DocxModel): number {
  if (model.kind === "streamed") return model.index.entries.size * 256 + model.layout.imageParts.length * 64;
  return bytesOf(model.blocks) + model.images.reduce((total, image) => total + image.length, 0);
}

export async function fitDocxImage(model: DocxModel, id: number, budget: DecodeBudget): Promise<EncodedImage> {
  const image = await embeddedImage(await docxImage(model, id), { maxWidth: DEFAULT_RENDER_WIDTH_PX, maxBytes: IMAGE_BUDGET_BYTES - MAX_ALT_CHARS * 6 }, budget);
  if (typeof image === "string") throw new Error(image);
  return image;
}

export async function blockPage(
  model: DocxModel,
  cursor: number,
  fitImage: (id: number) => Promise<EncodedImage | string>,
): Promise<BlockPage> {
  const blocks: DocBlock[] = [];
  let bytes = 0;
  let position = 0;
  for await (const source of docxBlocks(model)) {
    if (position++ < cursor) continue;
    if (blocks.length >= DOCX_MAX_BLOCKS) return { blocks, nextCursor: position - 1 };
    let block: DocBlock;
    if (source.type === "source-image") {
      const image = await fitImage(source.id);
      block =
        typeof image === "string" ? { type: "omitted-image", alt: source.alt, reason: image } : { type: "image", alt: source.alt, image };
    } else {
      block = source;
    }
    const blockBytes = bytesOf(block) + 1;
    if (blocks.length > 0 && bytes + blockBytes > PAGE_BUDGET_BYTES) return { blocks, nextCursor: position - 1 };
    blocks.push(block);
    bytes += blockBytes;
  }
  return { blocks, nextCursor: null };
}
