import { searchCursor, searchMatch } from "./search";
import { documentRevision, pagePins, pinLabel, reviewMark, viewerPosition } from "./viewer-state";
import { defineRpc } from "@getpaseo/plugin";
import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import { z } from "zod";
import { DOCUMENT_GROUPS } from "./browse";
import { DOCUMENT_KINDS } from "./kinds";
import { THUMBNAIL_MAX_WIDTH_PX, THUMBNAIL_MIN_WIDTH_PX } from "./limits";

const documentRef = { workspaceId: z.string().min(1), path: z.string().min(1) };
const password = z.string().min(1).max(1024).optional();
const revision = z.string();
const animationMimeType = z.enum(["image/gif", "image/webp"]);
const encodedImage = z.object({
  mimeType: z.enum(["image/png", "image/jpeg"]),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  data: z.string(),
});

export const docOpenRpc = defineRpc({
  name: "doc.open",
  input: z.object({ ...documentRef, password }),
  output: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("pdf"), revision, pageCount: z.number().int().nonnegative() }),
    z.object({ kind: z.literal("docx"), revision }),
    z.object({
      kind: z.enum(["xlsx", "csv"]),
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
    z.object({ kind: z.enum(["video", "audio"]), revision, mimeType: z.string(), size: z.number().int().nonnegative() }),
    z.object({
      kind: z.enum(["image-raster", "image-decoded"]),
      revision,
      width: z.number().int().positive(),
      height: z.number().int().positive(),
      animation: z.object({ mimeType: animationMimeType, size: z.number().int().positive() }).optional(),
    }),
  ]),
});

export const docPageRpc = defineRpc({
  name: "doc.page",
  input: z.object({
    ...documentRef,
    password,
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

export const docThumbnailRpc = defineRpc({
  name: "doc.thumbnail",
  input: z.object({
    ...documentRef,
    password,
    index: z.number().int().nonnegative(),
    width: z.number().int().min(THUMBNAIL_MIN_WIDTH_PX).max(THUMBNAIL_MAX_WIDTH_PX),
  }),
  output: z.object({
    kind: z.literal("pdf"),
    revision,
    index: z.number().int().nonnegative(),
    pageCount: z.number().int().nonnegative(),
    image: encodedImage,
  }),
});

export const docTextRpc = defineRpc({
  name: "doc.text",
  input: z.object({ ...documentRef, password, index: z.number().int().nonnegative() }),
  output: z.object({
    kind: z.literal("pdf"),
    revision,
    index: z.number().int().nonnegative(),
    pageCount: z.number().int().nonnegative(),
    text: z.string(),
    truncated: z.boolean(),
  }),
});

// `raw` is the stored value (the text for shared strings), null when nothing is stored; a formula
// without a stored value has no saved result. A shared formula's text is null when it cannot be derived.
export const cellDetail = z.object({
  type: z.enum(["n", "s", "b", "e", "d", "str", "inlineStr", "text"]),
  raw: z.string().nullable(),
  display: z.string(),
  numberFormat: z.string().optional(),
  formula: z.object({
    kind: z.enum(["normal", "shared", "array", "dataTable"]),
    text: z.string().nullable(),
    cached: z.boolean(),
    master: z.string().optional(),
    masterText: z.string().optional(),
    range: z.string().optional(),
    truncated: z.boolean().optional(),
  }).optional(),
});
export type CellDetail = z.infer<typeof cellDetail>;

export const docRowsRpc = defineRpc({
  name: "doc.rows",
  input: z.object({
    ...documentRef,
    sheet: z.number().int().nonnegative(),
    rowOffset: z.number().int().nonnegative(),
    columnOffset: z.number().int().nonnegative(),
    maxColumns: z.number().int().positive().optional(),
    maxRows: z.number().int().positive().optional(),
    detail: z.boolean().optional(),
  }),
  output: z.object({
    kind: z.enum(["xlsx", "csv"]),
    revision,
    sheet: z.number().int().nonnegative(),
    rowOffset: z.number().int().nonnegative(),
    columnOffset: z.number().int().nonnegative(),
    rowCount: z.number().int().nonnegative(),
    columnCount: z.number().int().nonnegative(),
    countsApproximate: z.boolean().optional(),
    rows: z.array(z.array(z.string())),
    details: z.array(z.array(cellDetail.nullable())).optional(),
    nextRowOffset: z.number().int().nonnegative().nullable(),
    nextColumnOffset: z.number().int().nonnegative().nullable(),
  }),
});

const issuesCursor = z.object({ revision, sheet: z.number().int().nonnegative(), row: z.number().int().nonnegative(), column: z.number().int().nonnegative() });

export const docIssuesRpc = defineRpc({
  name: "doc.issues",
  input: z.object({ ...documentRef, cursor: issuesCursor.nullable().optional() }),
  output: z.object({
    revision,
    issues: z.array(z.object({
      sheet: z.number().int().nonnegative(),
      row: z.number().int().nonnegative(),
      column: z.number().int().nonnegative(),
      kind: z.enum(["error", "missing-result"]),
      display: z.string(),
      formula: z.string().nullable(),
    })),
    // Rows [fromRow, toRow) of each sheet were fully inspected by this call.
    inspected: z.array(z.object({ sheet: z.number().int().nonnegative(), fromRow: z.number().int().nonnegative(), toRow: z.number().int().nonnegative() })),
    next: issuesCursor.nullable(),
    stopped: z.enum(["time", "rows", "issues"]).nullable(),
  }),
});
export type DocIssuesOutput = RpcOutput<typeof docIssuesRpc>;

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
    mimeType: animationMimeType.optional(),
  }),
  output: z.object({
    kind: z.enum(["video", "audio", "image-raster", "image-decoded"]),
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
  input: z.object({
    workspaceId: z.string().min(1),
    limit: z.number().int().positive().optional(),
    query: z.string().max(200).optional(),
    group: z.enum(DOCUMENT_GROUPS).optional(),
    needsReview: z.boolean().optional(),
  }),
  output: z.object({
    entries: z.array(
      z.object({
        path: z.string(),
        kind: z.enum(DOCUMENT_KINDS),
        mtimeMs: z.number(),
        size: z.number().int().nonnegative(),
        review: z.enum(["reviewed", "changed"]).optional(),
      }),
    ),
    truncated: z.boolean(),
    counts: z.record(z.enum(DOCUMENT_GROUPS), z.number().int().nonnegative()),
    needsReview: z.number().int().nonnegative(),
    // Up to 3 files matching the query that the viewer cannot open, sent only when no document matched.
    unsupported: z.array(z.string()).max(3).optional(),
  }),
});

export const docsAnyRpc = defineRpc({
  name: "docs.any",
  input: z.object({ workspaceId: z.string().min(1) }),
  output: z.object({ found: z.boolean() }),
});

export const fileInfoRpc = defineRpc({
  name: "file.info", input: z.object(documentRef),
  output: z.object({ revision, size: z.number().int().nonnegative(), name: z.string(), mimeType: z.string() }),
});
export const fileChunkRpc = defineRpc({
  name: "file.chunk", input: z.object({ ...documentRef, revision, offset: z.number().int().nonnegative(), length: z.number().int().positive() }),
  output: z.object({ revision, offset: z.number().int().nonnegative(), size: z.number().int().nonnegative(), data: z.string(), nextOffset: z.number().int().nonnegative().nullable() }),
});

export const docSearchRpc = defineRpc({
  name: "doc.search",
  input: z.object({ ...documentRef, password, query: z.string().trim().min(1).max(200), cursor: searchCursor.nullable().optional(),
    searchId: z.object({ session: z.string().min(1).max(64), generation: z.number().int().nonnegative() }).optional() }),
  output: z.object({ revision, matches: z.array(searchMatch).max(50), next: searchCursor.nullable(), notes: z.array(z.string()), scanned: z.number().int().nonnegative() }),
});
export type DocSearchOutput = RpcOutput<typeof docSearchRpc>;

export const viewerStateReadRpc = defineRpc({
  name: "viewer-state.read", input: z.object(documentRef),
  output: z.object({ saved: z.object({ position: viewerPosition }).nullable(), pins: pagePins, review: reviewMark.nullable() }),
});
export const viewerStateWriteRpc = defineRpc({
  name: "viewer-state.write", input: z.object({ ...documentRef, position: viewerPosition.nullable() }),
  output: z.object({ saved: z.boolean() }),
});
export const viewerStatePinRpc = defineRpc({
  name: "viewer-state.pin",
  input: z.object({ ...documentRef, index: z.number().int().nonnegative(), pin: z.object({ label: pinLabel.optional(), revision: documentRevision }).nullable() }),
  output: z.object({ pins: pagePins }),
});
export const viewerStateReviewRpc = defineRpc({
  name: "viewer-state.review",
  input: z.object({ ...documentRef, revision: documentRevision.nullable() }),
  output: z.object({ review: reviewMark.nullable(), revision: documentRevision }),
});

export const reviewPageImageRpc = defineRpc({
  name: "review.page-image",
  input: z.object({ ...documentRef, password, revision, index: z.number().int().nonnegative() }),
  output: z.object({ revision, index: z.number().int().nonnegative(), image: encodedImage }),
});
export type ReviewPageImageOutput = RpcOutput<typeof reviewPageImageRpc>;

export const DOCUMENT_RPCS = [docOpenRpc, docPageRpc, docThumbnailRpc, docTextRpc, docRowsRpc, docIssuesRpc, docBlocksRpc, mediaChunkRpc, docsRecentRpc, docsAnyRpc, fileInfoRpc, fileChunkRpc, docSearchRpc, viewerStateReadRpc, viewerStateWriteRpc, viewerStatePinRpc, viewerStateReviewRpc, reviewPageImageRpc] as const;

export type DocOpenInput = RpcInput<typeof docOpenRpc>;
export type DocOpenOutput = RpcOutput<typeof docOpenRpc>;
export type DocPageInput = RpcInput<typeof docPageRpc>;
export type DocPageOutput = RpcOutput<typeof docPageRpc>;
export type DocThumbnailOutput = RpcOutput<typeof docThumbnailRpc>;
export type DocTextInput = RpcInput<typeof docTextRpc>;
export type DocTextOutput = RpcOutput<typeof docTextRpc>;
export type DocRowsInput = RpcInput<typeof docRowsRpc>;
export type DocRowsOutput = RpcOutput<typeof docRowsRpc>;
export type DocBlocksInput = RpcInput<typeof docBlocksRpc>;
export type DocBlocksOutput = RpcOutput<typeof docBlocksRpc>;
export type MediaChunkInput = RpcInput<typeof mediaChunkRpc>;
export type MediaChunkOutput = RpcOutput<typeof mediaChunkRpc>;
export type DocsRecentInput = RpcInput<typeof docsRecentRpc>;
export type ViewerStateReadOutput = RpcOutput<typeof viewerStateReadRpc>;
export type DocsRecentOutput = RpcOutput<typeof docsRecentRpc>;
