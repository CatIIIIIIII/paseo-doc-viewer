import { type DocumentGroup, KIND_GROUP } from "../shared/browse";
import type { DocThumbnailInput, DocThumbnailOutput } from "../shared/rpc";
import type { BrowseRow, RecentEntry } from "./recent";
import { createThumbnailLoader, hasThumbnail, pageThumbnailKey, thumbnailAnswer, thumbnailCache, type ThumbnailCache, type ThumbnailState } from "./thumbnails";
import { cardThumbnailRetry } from "./turn-docs";

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

// The paths of the tiles on screen, then of the next row of tiles after each, so it loads before it scrolls in.
export function visibleTilePaths(items: readonly PreviewRow[], viewable: readonly number[]): Set<string> {
  const rows = new Set<number>();
  for (const index of viewable) {
    rows.add(index);
    const after = items.findIndex((item, at) => at > index && item.type === "tiles");
    if (after >= 0) rows.add(after);
  }
  return new Set([...rows].flatMap((index) => {
    const item = items[index];
    return item?.type === "tiles" ? item.entries.map((entry) => entry.path) : [];
  }));
}

export interface PreviewTarget {
  path: string;
  revision: string;
}

export interface PreviewLoader {
  // Asks for the targets on screen (all of them while nothing is known) and for nothing else.
  show(targets: readonly PreviewTarget[], visible: ReadonlySet<string> | null): void;
  state(target: PreviewTarget): ThumbnailState | undefined;
  subscribe(listener: () => void): () => void;
  close(): void;
}

// One per workspace and width. A keystroke or a rewrite only changes the targets, so answers on the way,
// failures and retries carry over: each path and revision is asked for once.
export function createPreviewLoader({ workspaceId, width, fetch, cache = thumbnailCache }: {
  workspaceId: string;
  width: number;
  fetch(input: DocThumbnailInput): Promise<DocThumbnailOutput>;
  cache?: ThumbnailCache;
}): PreviewLoader {
  const id = ({ path, revision }: PreviewTarget) => `${path}\0${revision}`;
  const target = (named: string): PreviewTarget => {
    const at = named.lastIndexOf("\0");
    return { path: named.slice(0, at), revision: named.slice(at + 1) };
  };
  const key = (path: string) => pageThumbnailKey(workspaceId, path, width, 0);
  const loader = createThumbnailLoader<string>({
    identify: (named) => {
      const { path, revision } = target(named);
      return { key: key(path), revision };
    },
    cache,
    fetch: (named) => {
      const { path, revision } = target(named);
      return fetch({ workspaceId, path, index: 0, width, keepOpen: false, revision }).then(thumbnailAnswer);
    },
    retryAfter: cardThumbnailRetry,
  });
  return {
    show: (targets, visible) => loader.want(targets.flatMap((each) => (visible === null || visible.has(each.path) ? [id(each)] : []))),
    state: (each) => loader.state(id(each)),
    subscribe: loader.subscribe,
    close: loader.close,
  };
}

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
