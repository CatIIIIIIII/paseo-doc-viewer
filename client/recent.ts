import type { PluginOpenScreenInput, PluginWorkspaceCommandContext } from "@getpaseo/plugin/client";
import { docsRecentRpc, type DocsRecentOutput } from "../shared/rpc";

export const DOCUMENT_SCREEN_ID = "document";
export const DOCUMENTS_PANEL_ID = "documents";

export type RecentEntry = DocsRecentOutput["entries"][number];

export function newestFirst(entries: readonly RecentEntry[]): RecentEntry[] {
  return [...entries].sort((a, b) => b.mtimeMs - a.mtimeMs || a.path.localeCompare(b.path));
}

export function documentScreen(workspaceId: string, path: string): PluginOpenScreenInput {
  return { screenId: DOCUMENT_SCREEN_ID, params: { workspaceId, path } };
}

type CommandContext = Pick<PluginWorkspaceCommandContext, "rpc" | "openScreen" | "openPanel"> & {
  workspace: { id: string };
};

export async function openMostRecent({ rpc, openScreen, openPanel, workspace }: CommandContext): Promise<void> {
  const { entries } = await rpc(docsRecentRpc, { workspaceId: workspace.id });
  const newest = newestFirst(entries)[0];
  if (!newest) {
    openPanel(DOCUMENTS_PANEL_ID);
    return;
  }
  openScreen(documentScreen(workspace.id, newest.path));
}

export function openByPath(context: CommandContext & { args: string }): Promise<void> | void {
  const path = context.args.trim().replace(/^\.\//, "");
  if (!path) return openMostRecent(context);
  context.openScreen(documentScreen(context.workspace.id, path));
}
