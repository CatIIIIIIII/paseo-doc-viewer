import type { PluginServerContext } from "@getpaseo/plugin/server";
import { listRecent, openDocument, readBlocks, readMediaChunk, readPageText, readRows, renderPage } from "./server/documents";
import { workspaceRoot } from "./server/paths";
import { docBlocksRpc, docOpenRpc, docPageRpc, docRowsRpc, docsRecentRpc, docTextRpc, mediaChunkRpc } from "./shared/rpc";

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
  return () => {};
}
