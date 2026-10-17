import { fileInfo, fileChunk } from "./server/files";
import { positionKey, viewerStateStore } from "./server/viewer-state";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { searchDocument, listRecent, openDocument, readBlocks, readMediaChunk, readPageText, readRows, renderPage } from "./server/documents";
import { workspaceRoot } from "./server/paths";
import { docBlocksRpc, docOpenRpc, docPageRpc, docRowsRpc, docsRecentRpc, docTextRpc, mediaChunkRpc, fileInfoRpc, fileChunkRpc, docSearchRpc, viewerStateReadRpc, viewerStateWriteRpc } from "./shared/rpc";

export default function contribute(server: PluginServerContext) {
  server.handle(docOpenRpc, async ({ workspaceId, path, password }, { paseo }) =>
    openDocument({ root: await workspaceRoot(paseo, workspaceId), path, password }),
  );
  server.handle(docPageRpc, async ({ workspaceId, path, password, ...request }, { paseo }) =>
    renderPage({ root: await workspaceRoot(paseo, workspaceId), path, password }, request),
  );
  server.handle(docTextRpc, async ({ workspaceId, path, password, ...request }, { paseo }) =>
    readPageText({ root: await workspaceRoot(paseo, workspaceId), path, password }, request),
  );
  server.handle(docRowsRpc, async ({ workspaceId, path, ...request }, { paseo }) =>
    readRows({ root: await workspaceRoot(paseo, workspaceId), path }, request),
  );
  server.handle(docBlocksRpc, async ({ workspaceId, path, ...request }, { paseo }) =>
    readBlocks({ root: await workspaceRoot(paseo, workspaceId), path }, request),
  );
  server.handle(mediaChunkRpc, async ({ workspaceId, path, ...request }, { paseo }) =>
    readMediaChunk({ root: await workspaceRoot(paseo, workspaceId), path }, request),
  );
  server.handle(docsRecentRpc, async ({ workspaceId, ...request }, { paseo }) =>
    listRecent(await workspaceRoot(paseo, workspaceId), request),
  );
  server.handle(fileInfoRpc, async ({ workspaceId, path }, { paseo }) =>
    fileInfo(await workspaceRoot(paseo, workspaceId), path),
  );
  server.handle(fileChunkRpc, async ({ workspaceId, path, revision, offset, length }, { paseo }) =>
    fileChunk(await workspaceRoot(paseo, workspaceId), path, revision, offset, length),
  );
  server.handle(docSearchRpc, async ({ workspaceId, path, password, query, cursor }, { paseo }) =>
    searchDocument({ root: await workspaceRoot(paseo, workspaceId), path, password }, query, cursor),
  );
  server.handle(viewerStateReadRpc, async ({ workspaceId, path }, { paseo }) => {
    const key = await positionKey(await workspaceRoot(paseo, workspaceId), path);
    return { saved: await viewerStateStore.read(key) };
  });
  server.handle(viewerStateWriteRpc, async ({ workspaceId, path, revision, position }, { paseo }) => {
    const key = await positionKey(await workspaceRoot(paseo, workspaceId), path);
    await viewerStateStore.write(key, revision, position);
    return { saved: true };
  });
  return () => {};
}
