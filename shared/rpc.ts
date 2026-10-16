import { defineRpc } from "@getpaseo/plugin";
import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import { z } from "zod";
import { DOCUMENT_KINDS } from "./kinds";

const documentRef = { workspaceId: z.string().min(1), path: z.string().min(1) };
const revision = z.string();
const encodedImage = z.object({
  mimeType: z.enum(["image/png", "image/jpeg"]),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  data: z.string(),
});

export const docOpenRpc = defineRpc({
  name: "doc.open",
  input: z.object(documentRef),
  output: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("pdf"), revision, pageCount: z.number().int().nonnegative() }),
    z.object({ kind: z.literal("docx"), revision }),
    z.object({
      kind: z.literal("xlsx"),
      revision,
      sheets: z.array(
        z.object({
          name: z.string(),
          rowCount: z.number().int().nonnegative(),
          columnCount: z.number().int().nonnegative(),
          countsApproximate: z.boolean().optional(),
        }),
      ),
      sheetsTruncated: z.boolean().optional(),
    }),
    z.object({ kind: z.literal("pptx"), revision, slideCount: z.number().int().nonnegative() }),
    z.object({ kind: z.literal("video"), revision, mimeType: z.string(), size: z.number().int().nonnegative() }),
    z.object({
      kind: z.enum(["image-raster", "image-decoded"]),
      revision,
      width: z.number().int().positive(),
      height: z.number().int().positive(),
    }),
  ]),
});

export const docPageRpc = defineRpc({
  name: "doc.page",
  input: z.object({
    ...documentRef,
    index: z.number().int().nonnegative(),
    maxWidth: z.number().int().positive().optional(),
  }),
  output: z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("pdf"),
      revision,
      index: z.number().int().nonnegative(),
      pageCount: z.number().int().nonnegative(),
      image: encodedImage,
    }),
    z.object({
      kind: z.literal("pptx"),
      revision,
      index: z.number().int().nonnegative(),
      slideCount: z.number().int().nonnegative(),
      texts: z.array(z.string()),
      images: z.array(encodedImage),
      omittedImages: z.number().int().nonnegative(),
      omittedReasons: z.array(z.string()).optional(),
    }),
    z.object({
      kind: z.enum(["image-raster", "image-decoded"]),
      revision,
      sourceWidth: z.number().int().positive(),
      sourceHeight: z.number().int().positive(),
      image: encodedImage,
    }),
  ]),
});

export const docTextRpc = defineRpc({
  name: "doc.text",
  input: z.object({ ...documentRef, index: z.number().int().nonnegative() }),
  output: z.object({
    kind: z.literal("pdf"),
    revision,
    index: z.number().int().nonnegative(),
    pageCount: z.number().int().nonnegative(),
    text: z.string(),
    truncated: z.boolean(),
  }),
});

export const docRowsRpc = defineRpc({
  name: "doc.rows",
  input: z.object({
    ...documentRef,
    sheet: z.number().int().nonnegative(),
    rowOffset: z.number().int().nonnegative(),
    columnOffset: z.number().int().nonnegative(),
    maxColumns: z.number().int().positive().optional(),
  }),
  output: z.object({
    kind: z.literal("xlsx"),
    revision,
    sheet: z.number().int().nonnegative(),
    rowOffset: z.number().int().nonnegative(),
    columnOffset: z.number().int().nonnegative(),
    rowCount: z.number().int().nonnegative(),
    columnCount: z.number().int().nonnegative(),
    countsApproximate: z.boolean().optional(),
    rows: z.array(z.array(z.string())),
    nextRowOffset: z.number().int().nonnegative().nullable(),
    nextColumnOffset: z.number().int().nonnegative().nullable(),
  }),
});

const docBlock = z.discriminatedUnion("type", [
  z.object({ type: z.literal("heading"), level: z.number().int().min(1).max(6), text: z.string() }),
  z.object({ type: z.literal("paragraph"), text: z.string() }),
  z.object({ type: z.literal("list"), ordered: z.boolean(), items: z.array(z.string()) }),
  z.object({ type: z.literal("table"), rows: z.array(z.array(z.string())) }),
  z.object({ type: z.literal("image"), alt: z.string(), image: encodedImage }),
  z.object({ type: z.literal("omitted-image"), alt: z.string(), reason: z.string() }),
]);
export type DocBlock = z.infer<typeof docBlock>;

export const docBlocksRpc = defineRpc({
  name: "doc.blocks",
  input: z.object({ ...documentRef, cursor: z.number().int().nonnegative() }),
  output: z.object({
    kind: z.literal("docx"),
    revision,
    blocks: z.array(docBlock),
    nextCursor: z.number().int().nonnegative().nullable(),
  }),
});

export const mediaChunkRpc = defineRpc({
  name: "media.chunk",
  input: z.object({
    ...documentRef,
    offset: z.number().int().nonnegative(),
    length: z.number().int().positive(),
  }),
  output: z.object({
    kind: z.literal("video"),
    revision,
    mimeType: z.string(),
    offset: z.number().int().nonnegative(),
    size: z.number().int().nonnegative(),
    data: z.string(),
    nextOffset: z.number().int().nonnegative().nullable(),
  }),
});

export const docsRecentRpc = defineRpc({
  name: "docs.recent",
  input: z.object({ workspaceId: z.string().min(1), limit: z.number().int().positive().optional() }),
  output: z.object({
    entries: z.array(
      z.object({
        path: z.string(),
        kind: z.enum(DOCUMENT_KINDS),
        mtimeMs: z.number(),
        size: z.number().int().nonnegative(),
      }),
    ),
    truncated: z.boolean(),
  }),
});

export const DOCUMENT_RPCS = [docOpenRpc, docPageRpc, docTextRpc, docRowsRpc, docBlocksRpc, mediaChunkRpc, docsRecentRpc] as const;

export type DocOpenInput = RpcInput<typeof docOpenRpc>;
export type DocOpenOutput = RpcOutput<typeof docOpenRpc>;
export type DocPageInput = RpcInput<typeof docPageRpc>;
export type DocPageOutput = RpcOutput<typeof docPageRpc>;
export type DocTextInput = RpcInput<typeof docTextRpc>;
export type DocTextOutput = RpcOutput<typeof docTextRpc>;
export type DocRowsInput = RpcInput<typeof docRowsRpc>;
export type DocRowsOutput = RpcOutput<typeof docRowsRpc>;
export type DocBlocksInput = RpcInput<typeof docBlocksRpc>;
export type DocBlocksOutput = RpcOutput<typeof docBlocksRpc>;
export type MediaChunkInput = RpcInput<typeof mediaChunkRpc>;
export type MediaChunkOutput = RpcOutput<typeof mediaChunkRpc>;
export type DocsRecentInput = RpcInput<typeof docsRecentRpc>;
export type DocsRecentOutput = RpcOutput<typeof docsRecentRpc>;
