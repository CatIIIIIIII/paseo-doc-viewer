import { z } from "zod";
import { DOCUMENT_KINDS, type DocumentKind } from "./kinds";

// The host accepts contribution ids matching /^[a-z][a-z0-9-]*$/ only; a dotted kind silently
// drops every client contribution of the plugin (packages/app/src/plugins/evaluate.ts).
export const TURN_DOCS_KIND = "turn-docs";
export const TURN_DOCS_VERSION = 2;
export const TURN_DOCS_MAX_FILES = 12;
// The daemon rejects a timeline row whose serialized data is over 64 KiB.
export const TIMELINE_DATA_MAX_BYTES = 64 * 1024;
// Filesystem timestamp granularity and clock skew between the agent's process and the plugin's.
export const TURN_WINDOW_SLACK_MS = 1_000;

export const turnDocsFileSchema = z.object({
  path: z.string(),
  kind: z.enum(DOCUMENT_KINDS),
  size: z.number(),
  revision: z.string(),
  status: z.enum(["new", "changed"]),
});

export const turnDocsGroupSchema = z.object({
  reason: z.enum(["checkout", "folder"]),
  path: z.string(),
  count: z.number(),
  files: z.array(turnDocsFileSchema),
});

export const turnDocsV1Schema = z.object({
  workspaceId: z.string(),
  startedAt: z.number(),
  endedAt: z.number(),
  outcome: z.enum(["completed", "failed", "canceled"]),
  files: z.array(turnDocsFileSchema),
  moreCount: z.number(),
  // The workspace scan hit its entry bound, so a changed file may be missing.
  partial: z.boolean(),
});

export const turnDocsSchema = turnDocsV1Schema.extend({ groups: z.array(turnDocsGroupSchema) });

export type TurnDocsFile = z.infer<typeof turnDocsFileSchema>;
export type TurnDocsGroup = z.infer<typeof turnDocsGroupSchema>;
export type TurnDocsV1 = z.infer<typeof turnDocsV1Schema>;
export type TurnDocs = z.infer<typeof turnDocsSchema>;

// Rows stored before folder rows existed stay in the timeline until the daemon restarts.
export const upgradeTurnDocs = (data: TurnDocsV1): TurnDocs => ({ ...data, groups: [] });

export interface ScannedFile {
  path: string;
  kind: DocumentKind;
  size: number;
  revision: string;
  // max(mtime, ctime): a copy or move that keeps the old mtime still counts.
  changedMs: number;
  birthtimeMs?: number;
}

export interface ScannedFolders {
  // Folder birth times, null where the filesystem has none.
  dirs: ReadonlyMap<string, number | null>;
  repos: ReadonlySet<string>;
}

// What existed when the turn started. `complete` is false when the scan hit its bound,
// so a file or folder missing here may still have existed.
export interface Baseline {
  revisions: ReadonlyMap<string, string>;
  dirs: ReadonlySet<string>;
  repos: ReadonlySet<string>;
  complete: boolean;
}

// Files whose content changed during the turn, newest first. A file that was in the baseline
// with the same revision is skipped, so the slack never reports an untouched file.
export function changedDuringTurn(after: readonly ScannedFile[], baseline: Baseline | null, startedAt: number): TurnDocsFile[] {
  const from = startedAt - TURN_WINDOW_SLACK_MS;
  return after
    .filter((file) => file.changedMs >= from && baseline?.revisions.get(file.path) !== file.revision)
    .sort((a, b) => b.changedMs - a.changedMs || a.path.localeCompare(b.path))
    .map((file) => ({ path: file.path, kind: file.kind, size: file.size, revision: file.revision, status: statusOf(file, baseline, from) }));
}

function statusOf(file: ScannedFile, baseline: Baseline | null, from: number): "new" | "changed" {
  if (baseline?.revisions.has(file.path)) return "changed";
  if (baseline?.complete) return "new";
  // No usable baseline: fall back to birth time, which is 0 or missing on some filesystems.
  return file.birthtimeMs !== undefined && file.birthtimeMs > 0 && file.birthtimeMs >= from ? "new" : "changed";
}

export function groupChanges(
  files: readonly TurnDocsFile[],
  after: ScannedFolders,
  baseline: Baseline | null,
  startedAt: number,
): { files: TurnDocsFile[]; groups: TurnDocsGroup[] } {
  const from = startedAt - TURN_WINDOW_SLACK_MS;
  const memo = new Map<string, "checkout" | "folder" | null>();
  const isNew = (dir: string) => {
    const born = after.dirs.get(dir);
    return (baseline?.complete === true && !baseline.dirs.has(dir)) || (born != null && born >= from);
  };
  const newRepo = (dir: string) =>
    after.repos.has(dir) && (isNew(dir) || (baseline?.complete === true && baseline.dirs.has(dir) && !baseline.repos.has(dir)));
  const newness = (dir: string) => {
    let known = memo.get(dir);
    if (known === undefined) {
      known = newRepo(dir) ? "checkout" : isNew(dir) ? "folder" : null;
      memo.set(dir, known);
    }
    return known;
  };

  const buckets = new Map<string, { reason: "checkout" | "folder"; files: TurnDocsFile[] }>();
  for (const file of files) {
    const dirs = ancestors(file.path);
    const checkout = dirs.find((dir) => newness(dir) === "checkout");
    const folder = checkout ?? dirs.find((dir) => newness(dir) !== null);
    if (folder === undefined) continue;
    const bucket = buckets.get(folder) ?? { reason: checkout === undefined ? "folder" as const : "checkout" as const, files: [] };
    bucket.files.push(file);
    buckets.set(folder, bucket);
  }
  const groups = [...buckets]
    .filter(([, bucket]) => bucket.reason === "checkout" || bucket.files.length > TURN_DOCS_MAX_FILES)
    .map(([path, bucket]): TurnDocsGroup => ({ reason: bucket.reason, path, count: bucket.files.length, files: bucket.files }));
  const grouped = new Set(groups.flatMap((group) => group.files));
  return { files: files.filter((file) => !grouped.has(file)), groups };
}

function ancestors(path: string): string[] {
  const parts = path.split("/").slice(0, -1);
  return parts.map((_, index) => parts.slice(0, index + 1).join("/"));
}

// One row per turn; null when nothing changed, so chat-only and canceled no-op turns add no card.
// Files past the cap, or past the daemon's 64 KiB data limit, count into moreCount.
export function turnDocsRow(
  input: Omit<TurnDocs, "files" | "groups" | "moreCount"> & { files: readonly TurnDocsFile[]; groups?: readonly TurnDocsGroup[]; turnId: string | null },
  { maxFiles = TURN_DOCS_MAX_FILES, maxBytes = TIMELINE_DATA_MAX_BYTES } = {},
): { type: "plugin"; id: string; kind: string; version: number; data: TurnDocs } | null {
  const { turnId, files, groups = [], ...rest } = input;
  if (files.length === 0 && groups.length === 0) return null;
  const total = files.length + groups.reduce((sum, group) => sum + group.count, 0);
  const shownGroups = groups.slice(0, maxFiles).map((group) => ({ ...group, files: group.files.slice(0, maxFiles) }));
  const shownFiles = files.slice(0, Math.max(0, maxFiles - shownGroups.length));
  const build = (): TurnDocs => {
    const shown = shownFiles.length + shownGroups.reduce((sum, group) => sum + group.count, 0);
    return { ...rest, files: shownFiles, groups: shownGroups, moreCount: total - shown };
  };
  let data = build();
  while (byteLength(JSON.stringify(data)) > maxBytes) {
    const widest = shownGroups.reduce<TurnDocsGroup | null>((best, group) => (group.files.length > (best?.files.length ?? 0) ? group : best), null);
    if (widest) widest.files = widest.files.slice(0, -1);
    else if (shownFiles.length > 0) shownFiles.pop();
    else if (shownGroups.length > 0) shownGroups.pop();
    else break;
    data = build();
  }
  return { type: "plugin", id: turnDocsRowId(turnId, input.startedAt), kind: TURN_DOCS_KIND, version: TURN_DOCS_VERSION, data };
}

// Stable per turn: a retried append replaces the row instead of adding a second card. The start time
// keeps ids apart when a provider reuses turn ids, for example after a resume.
export function turnDocsRowId(turnId: string | null, startedAt: number): string {
  return `turn-docs:${turnId ?? "turn"}:${startedAt}`;
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}
