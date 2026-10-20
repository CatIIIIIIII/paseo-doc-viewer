export const DOCUMENT_KINDS = ["pdf", "docx", "xlsx", "csv", "jsonl", "parquet", "pptx", "video", "audio", "image-raster", "image-decoded"] as const;
export type DocumentKind = (typeof DOCUMENT_KINDS)[number];

export type PagedRpc = "doc.page" | "doc.thumbnail" | "doc.text" | "doc.rows" | "doc.cell" | "doc.blocks" | "media.chunk";

export interface MagicSignature {
  offset: number;
  bytes: readonly number[];
}

export interface KindSpec {
  extensions: readonly string[];
  magic: readonly MagicSignature[] | "text";
  rpcs: readonly PagedRpc[];
}

const ascii = (offset: number, text: string): MagicSignature => ({
  offset,
  bytes: Array.from(text, (char) => char.charCodeAt(0)),
});
const zip: MagicSignature = { offset: 0, bytes: [0x50, 0x4b, 0x03, 0x04] };

export const KIND_REGISTRY: { readonly [K in DocumentKind]: KindSpec } = {
  pdf: { extensions: ["pdf"], magic: [ascii(0, "%PDF-")], rpcs: ["doc.page", "doc.thumbnail", "doc.text"] },
  docx: { extensions: ["docx"], magic: [zip], rpcs: ["doc.blocks"] },
  xlsx: { extensions: ["xlsx"], magic: [zip], rpcs: ["doc.rows", "doc.cell"] },
  csv: { extensions: ["csv", "tsv"], magic: "text", rpcs: ["doc.rows", "doc.cell"] },
  jsonl: { extensions: ["jsonl", "ndjson"], magic: "text", rpcs: ["doc.rows", "doc.cell"] },
  parquet: { extensions: ["parquet"], magic: [ascii(0, "PAR1")], rpcs: ["doc.rows", "doc.cell"] },
  pptx: { extensions: ["pptx"], magic: [zip], rpcs: ["doc.page", "doc.thumbnail"] },
  video: {
    extensions: ["mp4", "m4v", "mov", "webm"],
    magic: [ascii(4, "ftyp"), { offset: 0, bytes: [0x1a, 0x45, 0xdf, 0xa3] }],
    rpcs: ["media.chunk"],
  },
  audio: {
    extensions: ["mp3", "m4a", "wav", "flac"],
    magic: [ascii(0, "ID3"), ascii(4, "ftyp"), ascii(0, "RIFF"), ascii(0, "fLaC")],
    rpcs: ["media.chunk"],
  },
  "image-raster": {
    extensions: ["png", "jpg", "jpeg", "gif"],
    magic: [{ offset: 0, bytes: [0x89, 0x50, 0x4e, 0x47] }, { offset: 0, bytes: [0xff, 0xd8, 0xff] }, ascii(0, "GIF8")],
    rpcs: ["doc.page", "doc.thumbnail", "media.chunk"],
  },
  "image-decoded": {
    extensions: ["tif", "tiff", "heic", "heif", "webp"],
    magic: [
      ascii(0, "II*\0"),
      ascii(0, "MM\0*"),
      ascii(4, "ftypheic"),
      ascii(4, "ftypheix"),
      ascii(4, "ftypmif1"),
      ascii(8, "WEBPVP8"),
    ],
    rpcs: ["doc.page", "doc.thumbnail", "media.chunk"],
  },
};

const KIND_BY_EXTENSION = new Map<string, DocumentKind>(
  DOCUMENT_KINDS.flatMap((kind) => KIND_REGISTRY[kind].extensions.map((extension) => [extension, kind] as const)),
);

export function extensionOf(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

export function kindForPath(path: string): DocumentKind | null {
  return KIND_BY_EXTENSION.get(extensionOf(path)) ?? null;
}

export function matchesMagic(signature: MagicSignature, head: Uint8Array): boolean {
  return signature.bytes.every((byte, i) => head[signature.offset + i] === byte);
}

export function looksLikeText(head: Uint8Array): boolean {
  return !head.includes(0);
}

export function detectKind(path: string, head: Uint8Array): DocumentKind | null {
  const kind = kindForPath(path);
  if (!kind) return null;
  if (kind === "audio") {
    const extension = extensionOf(path);
    const has = (offset: number, text: string) => matchesMagic(ascii(offset, text), head);
    const mp3Frame = head.length >= 4 && head[0] === 0xff && (head[1]! & 0xe0) === 0xe0 &&
      (head[1]! & 0x18) !== 0x08 && (head[1]! & 6) !== 0 &&
      (head[2]! & 0xf0) !== 0 && (head[2]! & 0xf0) !== 0xf0 && (head[2]! & 0x0c) !== 0x0c;
    const valid = extension === "mp3" ? has(0, "ID3") || mp3Frame
      : extension === "m4a" ? has(4, "ftyp")
      : extension === "wav" ? has(0, "RIFF") && has(8, "WAVE")
      : extension === "flac" && has(0, "fLaC");
    return valid ? kind : null;
  }
  const { magic } = KIND_REGISTRY[kind];
  const matches = magic === "text" ? looksLikeText(head) : magic.some((signature) => matchesMagic(signature, head));
  return matches ? kind : null;
}
