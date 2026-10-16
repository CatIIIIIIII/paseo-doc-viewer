export const DOCUMENT_KINDS = ["pdf", "docx", "xlsx", "pptx", "video", "image-raster", "image-decoded"] as const;
export type DocumentKind = (typeof DOCUMENT_KINDS)[number];

export type PagedRpc = "doc.page" | "doc.text" | "doc.rows" | "doc.blocks" | "media.chunk";

export interface MagicSignature {
  offset: number;
  bytes: readonly number[];
}

export interface KindSpec {
  extensions: readonly string[];
  magic: readonly MagicSignature[];
  rpcs: readonly PagedRpc[];
}

const ascii = (offset: number, text: string): MagicSignature => ({
  offset,
  bytes: Array.from(text, (char) => char.charCodeAt(0)),
});
const zip: MagicSignature = { offset: 0, bytes: [0x50, 0x4b, 0x03, 0x04] };

export const KIND_REGISTRY: { readonly [K in DocumentKind]: KindSpec } = {
  pdf: { extensions: ["pdf"], magic: [ascii(0, "%PDF-")], rpcs: ["doc.page", "doc.text"] },
  docx: { extensions: ["docx"], magic: [zip], rpcs: ["doc.blocks"] },
  xlsx: { extensions: ["xlsx"], magic: [zip], rpcs: ["doc.rows"] },
  pptx: { extensions: ["pptx"], magic: [zip], rpcs: ["doc.page"] },
  video: {
    extensions: ["mp4", "m4v", "mov", "webm"],
    magic: [ascii(4, "ftyp"), { offset: 0, bytes: [0x1a, 0x45, 0xdf, 0xa3] }],
    rpcs: ["media.chunk"],
  },
  "image-raster": {
    extensions: ["png", "jpg", "jpeg", "gif"],
    magic: [{ offset: 0, bytes: [0x89, 0x50, 0x4e, 0x47] }, { offset: 0, bytes: [0xff, 0xd8, 0xff] }, ascii(0, "GIF8")],
    rpcs: ["doc.page"],
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
    rpcs: ["doc.page"],
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

export function detectKind(path: string, head: Uint8Array): DocumentKind | null {
  const kind = kindForPath(path);
  if (!kind) return null;
  return KIND_REGISTRY[kind].magic.some((signature) => matchesMagic(signature, head)) ? kind : null;
}
