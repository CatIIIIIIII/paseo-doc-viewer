import { type DocumentGroup, KIND_GROUP } from "../shared/browse";
import type { BrowseRow, RecentEntry } from "./recent";
import { hasThumbnail } from "./thumbnails";

export const PREVIEW_GROUPS: ReadonlySet<DocumentGroup> = new Set(["pdf", "powerpoint", "image"]);
export const PREVIEW_MAX_BYTES = 64 * 1024 * 1024;
export const PREVIEW_HOLD_MS = 5_000;

export type PreviewRow =
  | Extract<BrowseRow, { type: "header" }>
  | Extract<BrowseRow, { type: "entry" }>
  | { type: "tiles"; key: string; entries: RecentEntry[] };

export const previewRowKey = (row: PreviewRow) =>
  row.type === "header" ? `group:${row.group}` : row.type === "tiles" ? row.key : row.entry.path;

export function previewRows(rows: readonly BrowseRow[], columns: number): PreviewRow[] {
  const result: PreviewRow[] = [];
  let run: RecentEntry[] = [];
  const flush = () => {
    for (let start = 0; start < run.length; start += columns) {
      const entries = run.slice(start, start + columns);
      result.push({ type: "tiles", key: `tiles:${entries[0]!.path}`, entries });
    }
    run = [];
  };
  for (const row of rows) {
    if (row.type === "entry" && PREVIEW_GROUPS.has(KIND_GROUP[row.entry.kind])) {
      if (run.length > 0 && KIND_GROUP[run[0]!.kind] !== KIND_GROUP[row.entry.kind]) flush();
      run.push(row.entry);
      continue;
    }
    flush();
    result.push(row);
  }
  flush();
  return result;
}

export const wantsPreview = (entry: Pick<RecentEntry, "kind" | "size">) => hasThumbnail(entry.kind) && entry.size <= PREVIEW_MAX_BYTES;

export interface HeldRevision {
  seen: string;
  since: number;
  held: string;
}

export function holdRevisions(
  previous: ReadonlyMap<string, HeldRevision>,
  entries: readonly Pick<RecentEntry, "path" | "revision">[],
  now: number,
): Map<string, HeldRevision> {
  const next = new Map<string, HeldRevision>();
  for (const { path, revision } of entries) {
    const known = previous.get(path);
    if (!known) next.set(path, { seen: revision, since: now, held: revision });
    else if (known.seen !== revision) next.set(path, { seen: revision, since: now, held: known.held });
    else if (known.held !== revision && now - known.since >= PREVIEW_HOLD_MS) next.set(path, { ...known, held: revision });
    else next.set(path, known);
  }
  return next;
}

export function nextRelease(held: ReadonlyMap<string, HeldRevision>, now: number): number | null {
  let soonest: number | null = null;
  for (const { seen, since, held: current } of held.values()) {
    if (seen === current) continue;
    const wait = Math.max(0, since + PREVIEW_HOLD_MS - now);
    soonest = soonest === null ? wait : Math.min(soonest, wait);
  }
  return soonest;
}
