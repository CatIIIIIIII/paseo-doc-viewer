import type { PluginOpenScreenInput, PluginWorkspaceCommandContext } from "@getpaseo/plugin/client";
import {
  type BrowseFilter,
  DOCUMENT_GROUPS,
  type DocumentGroup,
  type GroupCounts,
  groupEntries,
  KIND_GROUP,
  newestFirst,
  type RecentCut,
  SCAN_CUTS,
  type ScanCut,
} from "../shared/browse";
import type { DocumentView } from "../shared/documents-view";
import { extensionOf } from "../shared/kinds";
import { MAX_RESPONSE_BYTES, RECENT_MAX_DEPTH, RECENT_MAX_FOLDER_ENTRIES, RECENT_MAX_SCANNED_ENTRIES } from "../shared/limits";
import { docsRecentRpc, type DocsRecentInput, type DocsRecentList, type DocsRecentOutput } from "../shared/rpc";
import { baseName, formatCount, GROUP_FILES, KIND_LABEL, parentDir, relativeTime } from "./format";
import { encodeSiblings } from "./siblings";

export const DOCUMENT_SCREEN_ID = "document";
export const DOCUMENTS_PANEL_ID = "documents";
export const SETTINGS_SCREEN_ID = "viewer";

export type RecentEntry = DocsRecentList["entries"][number];

// Sends the version of the list it holds, so a list that did not change comes back in a few bytes.
// An older daemon ignores the version and sends the whole list.
export async function fetchRecent(
  call: (input: DocsRecentInput) => Promise<DocsRecentOutput>,
  request: DocsRecentInput,
  held?: DocsRecentList,
): Promise<DocsRecentList> {
  const answer = await call(held?.version ? { ...request, since: held.version } : request);
  if (!("unchanged" in answer)) return answer;
  if (held) return held;
  throw new Error("docs.recent answered unchanged to a request without a version");
}

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

const SPOKEN_STATUS = { reviewed: "reviewed", changed: "changed since review" } as const;

export function entryLabel(entry: RecentEntry, now: number, extra: readonly string[] = []): string {
  const folder = parentDir(entry.path);
  const status = entry.review ? SPOKEN_STATUS[entry.review] : entry.isNew ? "new" : null;
  return [
    baseName(entry.path),
    KIND_LABEL[entry.kind],
    ...(folder ? [`in ${folder}`] : []),
    `changed ${relativeTime(entry.mtimeMs, now)}`,
    ...extra,
    ...(status ? [status] : []),
  ].join(", ");
}

export function filterChips(counts: GroupCounts, selected: DocumentGroup | null): { group: DocumentGroup | null; count: number }[] {
  const total = DOCUMENT_GROUPS.reduce((sum, group) => sum + counts[group], 0);
  const present = DOCUMENT_GROUPS.filter((group) => counts[group] > 0 || group === selected);
  return [{ group: null, count: total }, ...present.map((group) => ({ group, count: counts[group] }))];
}

const SCAN_NOTES: { readonly [C in ScanCut]: string } = {
  entries: `Only the first ${formatCount(RECENT_MAX_SCANNED_ENTRIES)} entries of this workspace were scanned`,
  folder: `Folders with more than ${formatCount(RECENT_MAX_FOLDER_ENTRIES)} entries were only partly scanned`,
  depth: `Folders more than ${RECENT_MAX_DEPTH} levels deep were not scanned`,
};

const scanNotes = (cuts: readonly RecentCut[]) => SCAN_CUTS.filter((cut) => cuts.includes(cut)).map((cut) => SCAN_NOTES[cut]);

// An older daemon says only that the list was cut, which reads as the limit.
export const recentCuts = ({ truncated, truncatedBy }: { truncated: boolean; truncatedBy?: readonly RecentCut[] }): readonly RecentCut[] =>
  truncatedBy ?? (truncated ? ["limit"] : []);

export function noMatchDetail({ query = "", group = null, needsReview = false, newOnly = false }: BrowseFilter, cuts: readonly RecentCut[]): string {
  const files = `${newOnly ? "new " : ""}${group ? GROUP_FILES[group] : "files"}${needsReview ? " changed since review" : ""}`;
  const text = query.trim();
  const detail = text ? `No ${files} match "${text}"` : needsReview || newOnly ? `No ${files}` : `No ${files} in this workspace`;
  return [detail, ...scanNotes(cuts)].join(". ");
}

// What a workspace without documents says: what appears here, and what the scan did not reach.
export const emptyDetail = (cuts: readonly RecentCut[]): string =>
  ["PDF, Word, Excel, CSV, JSON Lines, Parquet, PowerPoint, image, video, and audio files in this workspace appear here", ...scanNotes(cuts)].join(". ");

// A search that only matched files the viewer cannot open says so instead of "No files match".
export function unsupportedDetail(paths: readonly string[]): string | null {
  if (paths.length === 0) return null;
  const types = [...new Set(paths.map((path) => (extensionOf(path) ? `.${extensionOf(path)}` : "a file without an extension")))];
  const verdict = types.length === 1 ? `${types[0]} is not a supported type` : `${types.join(", ")} are not supported types`;
  return `Found ${paths.join(", ")}, but ${verdict}. The viewer opens PDF, Word, Excel, CSV, TSV, PowerPoint, image, video and audio files.`;
}

// Why the list may hold fewer documents than the workspace, one sentence per reason; null when it holds them all.
// Tree's folder counts then cover only the listed documents.
export function truncationNotice(listed: number, cuts: readonly RecentCut[], filtered: boolean, view: DocumentView): string | null {
  const things = filtered ? "matches" : "documents";
  const shown = `Showing the ${formatCount(listed)} most recently changed ${things}`;
  const cut = cuts.includes("bytes") ? [`${shown}, as many names as fit in ${MAX_RESPONSE_BYTES / 1024 ** 2} MB`] : cuts.includes("limit") ? [shown] : [];
  const counted = cut.length > 0 && view === "tree" ? ["Folder counts include only these"] : [];
  const notes = [...cut, ...counted, ...scanNotes(cuts)];
  return notes.length > 0 ? notes.join(". ") : null;
}

export function documentScreen(workspaceId: string, path: string, siblings?: readonly string[]): PluginOpenScreenInput {
  const encoded = siblings ? encodeSiblings(siblings) : null;
  return { screenId: DOCUMENT_SCREEN_ID, params: encoded ? { workspaceId, path, siblings: encoded } : { workspaceId, path } };
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
  const list = (request: DocsRecentInput) => fetchRecent((input) => rpc(docsRecentRpc, input), request);
  const { entries, counts } = await list({ workspaceId });
  const newest = newestFirst(entries);
  const reading = newest.find(isReading);
  if (reading) return reading;
  const missing = READING_GROUPS.filter((group) => counts[group] > 0);
  if (missing.length === 0) return newest[0];
  const found = await Promise.all(missing.map((group) => list({ workspaceId, group, limit: 1 })));
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
