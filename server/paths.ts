import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { ERROR_MESSAGES } from "../shared/errors";

const WORKSPACE_PAGE_SIZE = 200;
const MAX_WORKSPACE_PAGES = 100;

export async function workspaceRoot(paseo: PluginHandlerContext["paseo"], workspaceId: string): Promise<string> {
  let cursor: string | undefined;
  for (let page = 0; page < MAX_WORKSPACE_PAGES; page++) {
    const result = await paseo.workspaces.list({ page: { limit: WORKSPACE_PAGE_SIZE, ...(cursor ? { cursor } : {}) } });
    const workspace = result.entries.find((entry) => entry.id === workspaceId);
    if (workspace) {
      const directory = workspace.workspaceDirectory || workspace.projectRootPath;
      if (!directory) throw new Error(ERROR_MESSAGES.workspaceWithoutDirectory(workspaceId));
      return realpath(directory).catch(() => {
        throw new Error(ERROR_MESSAGES.workspaceWithoutDirectory(workspaceId));
      });
    }
    const next = result.pageInfo?.nextCursor ?? undefined;
    if (!result.pageInfo?.hasMore || !next || next === cursor) break;
    cursor = next;
  }
  throw new Error(ERROR_MESSAGES.workspaceNotFound(workspaceId));
}

function notFound(path: string) {
  return (error: NodeJS.ErrnoException): never => {
    throw error.code === "ENOENT" || error.code === "ENOTDIR" ? new Error(ERROR_MESSAGES.fileNotFound(path)) : error;
  };
}

function contains(root: string, target: string): boolean {
  const path = relative(root, target);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

export async function resolveInside(root: string, relativePath: string): Promise<string> {
  if (relativePath.includes("\0")) throw new Error(ERROR_MESSAGES.invalidPath());
  const lexical = resolve(root, relativePath);
  if (!contains(root, lexical)) throw new Error(ERROR_MESSAGES.outsideWorkspace());
  const [realRoot, target] = await Promise.all([realpath(root), realpath(lexical).catch(notFound(relativePath))]);
  if (!contains(realRoot, target)) throw new Error(ERROR_MESSAGES.outsideWorkspace());
  return target;
}
