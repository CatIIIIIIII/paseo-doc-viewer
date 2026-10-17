import type { PluginOpenScreenInput, PluginWorkspaceCommandContext } from "@getpaseo/plugin/client";
import {
  type BrowseFilter,
  DOCUMENT_GROUPS,
  type DocumentGroup,
  type GroupCounts,
  groupEntries,
  KIND_GROUP,
  newestFirst,
} from "../shared/browse";
import { extensionOf } from "../shared/kinds";
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

export function noMatchDetail({ query = "", group = null, needsReview = false }: BrowseFilter, scanIncomplete: boolean): string {
  const files = `${group ? GROUP_FILES[group] : "files"}${needsReview ? " changed since review" : ""}`;
  const text = query.trim();
  const detail = text ? `No ${files} match "${text}"` : needsReview ? `No ${files}` : `No ${files} in this workspace`;
  return scanIncomplete
    ? `${detail}. Only the first ${formatCount(RECENT_MAX_SCANNED_ENTRIES)} entries of this workspace were searched`
    : detail;
}

// A search that only matched files the viewer cannot open says so instead of "No files match".
export function unsupportedDetail(paths: readonly string[]): string | null {
  if (paths.length === 0) return null;
  const types = [...new Set(paths.map((path) => (extensionOf(path) ? `.${extensionOf(path)}` : "a file without an extension")))];
  const verdict = types.length === 1 ? `${types[0]} is not a supported type` : `${types.join(", ")} are not supported types`;
  return `Found ${paths.join(", ")}, but ${verdict}. The viewer opens PDF, Word, Excel, CSV, TSV, PowerPoint, image, video and audio files.`;
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

// Groups a reader opens on purpose; images, video and audio are usually by-products such as screenshots.
export const READING_GROUPS: readonly DocumentGroup[] = ["pdf", "word", "excel", "powerpoint"];
const isReading = (entry: RecentEntry) => READING_GROUPS.includes(KIND_GROUP[entry.kind]);

// The most relevant document: the newest PDF, Word, spreadsheet or slide file, else the newest
// supported file of any type. The list is capped, so when screenshots crowd documents out of it the
// per-group counts tell which groups to ask for; those calls reuse the daemon's workspace scan.
export async function mostRelevant(rpc: CommandContext["rpc"], workspaceId: string): Promise<RecentEntry | undefined> {
  const { entries, counts } = await rpc(docsRecentRpc, { workspaceId });
  const newest = newestFirst(entries);
  const reading = newest.find(isReading);
  if (reading) return reading;
  const missing = READING_GROUPS.filter((group) => counts[group] > 0);
  if (missing.length === 0) return newest[0];
  const found = await Promise.all(missing.map((group) => rpc(docsRecentRpc, { workspaceId, group, limit: 1 })));
  return newestFirst(found.flatMap((result) => result.entries))[0] ?? newest[0];
}

export async function openMostRecent({ rpc, openScreen, openPanel, workspace }: CommandContext): Promise<void> {
  const newest = await mostRelevant(rpc, workspace.id);
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
