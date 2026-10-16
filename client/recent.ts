import type { PluginOpenScreenInput, PluginWorkspaceCommandContext } from "@getpaseo/plugin/client";
import {
  type BrowseFilter,
  DOCUMENT_GROUPS,
  type DocumentGroup,
  type GroupCounts,
  groupEntries,
  newestFirst,
} from "../shared/browse";
import { RECENT_MAX_SCANNED_ENTRIES } from "../shared/limits";
import { docsRecentRpc, type DocsRecentOutput } from "../shared/rpc";
import { formatCount, GROUP_FILES } from "./format";

export const DOCUMENT_SCREEN_ID = "document";
export const DOCUMENTS_PANEL_ID = "documents";

export type RecentEntry = DocsRecentOutput["entries"][number];

export type BrowseRow =
  | { type: "header"; group: DocumentGroup; shown: number; total: number; collapsed: boolean }
  | { type: "entry"; entry: RecentEntry };

export function browseRows(
  entries: readonly RecentEntry[],
  { counts, collapsed, headers }: { counts: GroupCounts; collapsed: ReadonlySet<DocumentGroup>; headers: boolean },
): BrowseRow[] {
  if (!headers) return newestFirst(entries).map((entry) => ({ type: "entry", entry }));
  return groupEntries(entries).flatMap(({ group, entries: members }): BrowseRow[] => {
    const isCollapsed = collapsed.has(group);
    const header: BrowseRow = {
      type: "header",
      group,
      shown: members.length,
      total: Math.max(members.length, counts[group]),
      collapsed: isCollapsed,
    };
    return isCollapsed ? [header] : [header, ...members.map((entry): BrowseRow => ({ type: "entry", entry }))];
  });
}

export function filterChips(counts: GroupCounts, selected: DocumentGroup | null): { group: DocumentGroup | null; count: number }[] {
  const total = DOCUMENT_GROUPS.reduce((sum, group) => sum + counts[group], 0);
  const present = DOCUMENT_GROUPS.filter((group) => counts[group] > 0 || group === selected);
  return [{ group: null, count: total }, ...present.map((group) => ({ group, count: counts[group] }))];
}

export function noMatchDetail({ query = "", group = null }: BrowseFilter, scanIncomplete: boolean): string {
  const files = group ? GROUP_FILES[group] : "files";
  const text = query.trim();
  const detail = text ? `No ${files} match "${text}"` : `No ${files} in this workspace`;
  return scanIncomplete
    ? `${detail}. Only the first ${formatCount(RECENT_MAX_SCANNED_ENTRIES)} entries of this workspace were searched`
    : detail;
}

export function listFooter(shown: number, filtered: boolean): string {
  return filtered ? `Showing the ${shown} most recent matches` : `Showing the ${shown} most recently changed`;
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
