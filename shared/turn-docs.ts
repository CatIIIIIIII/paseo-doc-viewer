import { z } from "zod";
import { DOCUMENT_KINDS, type DocumentKind } from "./kinds";

// The host accepts contribution ids matching /^[a-z][a-z0-9-]*$/ only; a dotted kind silently
// drops every client contribution of the plugin (packages/app/src/plugins/evaluate.ts).
export const TURN_DOCS_KIND = "turn-docs";
export const TURN_DOCS_VERSION = 1;
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

export const turnDocsSchema = z.object({
  workspaceId: z.string(),
  startedAt: z.number(),
  endedAt: z.number(),
  outcome: z.enum(["completed", "failed", "canceled"]),
  files: z.array(turnDocsFileSchema),
  moreCount: z.number(),
  // The workspace scan hit its entry bound, so a changed file may be missing.
  partial: z.boolean(),
});

export type TurnDocsFile = z.infer<typeof turnDocsFileSchema>;
export type TurnDocs = z.infer<typeof turnDocsSchema>;

export interface ScannedFile {
  path: string;
  kind: DocumentKind;
  size: number;
  revision: string;
  // max(mtime, ctime): a copy or move that keeps the old mtime still counts.
  changedMs: number;
  birthtimeMs?: number;
}

// What existed when the turn started. `complete` is false when the scan hit its bound,
// so a file missing from `revisions` may still have existed.
export interface Baseline {
  revisions: ReadonlyMap<string, string>;
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

// One row per turn; null when nothing changed, so chat-only and canceled no-op turns add no card.
// Files past the cap, or past the daemon's 64 KiB data limit, count into moreCount.
export function turnDocsRow(
  input: Omit<TurnDocs, "files" | "moreCount"> & { files: readonly TurnDocsFile[]; turnId: string | null },
  { maxFiles = TURN_DOCS_MAX_FILES, maxBytes = TIMELINE_DATA_MAX_BYTES } = {},
): { type: "plugin"; id: string; kind: string; version: number; data: TurnDocs } | null {
  const { turnId, files, ...rest } = input;
  if (files.length === 0) return null;
  let shown = files.slice(0, maxFiles);
  let data: TurnDocs = { ...rest, files: shown, moreCount: files.length - shown.length };
  while (shown.length > 0 && byteLength(JSON.stringify(data)) > maxBytes) {
    shown = shown.slice(0, -1);
    data = { ...rest, files: shown, moreCount: files.length - shown.length };
  }
  return { type: "plugin", id: turnDocsRowId(input.workspaceId, turnId, input.startedAt), kind: TURN_DOCS_KIND, version: TURN_DOCS_VERSION, data };
}

// Stable per turn: a retried append replaces the row instead of adding a second card.
export function turnDocsRowId(workspaceId: string, turnId: string | null, startedAt: number): string {
  return `turn-docs:${turnId ?? `${workspaceId}:${startedAt}`}`;
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}
