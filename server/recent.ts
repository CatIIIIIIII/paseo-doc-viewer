import { opendir, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { countGroups, type BrowseFilter, type GroupCounts, filterEntries, matchesQuery, newestFirst, queryTerms, type ReviewStatus } from "../shared/browse";
import { RECENT_MAX_ENTRIES, RECENT_MAX_SCANNED_ENTRIES } from "../shared/limits";
import { kindForPath, type DocumentKind } from "../shared/kinds";
import { revisionOf } from "./revision";

export interface RecentEntry {
  path: string;
  kind: DocumentKind;
  mtimeMs: number;
  size: number;
  revision: string;
  review?: ReviewStatus;
}

const SKIPPED_DIRECTORIES = new Set(["node_modules", "__pycache__", "venv", "target", "vendor"]);
const DEFERRED_DIRECTORIES = new Set(["build", "dist", "out"]);
const SKIPPED_FILE_PREFIXES = ["~$", "._"];
const MAX_DIRECTORY_ENTRIES = 5_000;
const MAX_DEPTH = 16;
const MIN_REUSE_MS = 4_000;
const REUSE_FACTOR = 10;

interface Pending {
  path: string;
  depth: number;
  mtimeMs: number;
  deferred: boolean;
}

const before = (a: Pending, b: Pending) => (a.deferred === b.deferred ? a.mtimeMs > b.mtimeMs : b.deferred);

class Queue {
  private heap: Pending[] = [];

  get size(): number {
    return this.heap.length;
  }

  push(item: Pending): void {
    const heap = this.heap;
    heap.push(item);
    for (let i = heap.length - 1; i > 0; ) {
      const parent = (i - 1) >> 1;
      if (!before(heap[i], heap[parent])) break;
      [heap[parent], heap[i]] = [heap[i], heap[parent]];
      i = parent;
    }
  }

  pop(): Pending {
    const heap = this.heap;
    const top = heap[0];
    const last = heap.pop()!;
    if (heap.length > 0) {
      heap[0] = last;
      for (let i = 0; ; ) {
        const left = 2 * i + 1;
        const right = left + 1;
        let first = i;
        if (left < heap.length && before(heap[left], heap[first])) first = left;
        if (right < heap.length && before(heap[right], heap[first])) first = right;
        if (first === i) break;
        [heap[first], heap[i]] = [heap[i], heap[first]];
        i = first;
      }
    }
    return top;
  }
}

interface Scan {
  entries: RecentEntry[];
  // Other files, so a search can say a file exists but is not a supported type.
  unsupported: string[];
  complete: boolean;
}

const MAX_UNSUPPORTED_NAMES = 10_000;
const MAX_UNSUPPORTED_SHOWN = 3;

const scans = new Map<string, { result: Promise<Scan>; expiresAt: number }>();

export async function recentDocuments(
  root: string,
  { limit = RECENT_MAX_ENTRIES, query, group, needsReview }: BrowseFilter & { limit?: number } = {},
  reviewStatus?: (entry: RecentEntry) => ReviewStatus | undefined,
): Promise<{ entries: RecentEntry[]; truncated: boolean; counts: GroupCounts; needsReview: number; unsupported?: string[] }> {
  const scan = await sharedScan(root);
  const cap = Math.max(1, Math.min(limit, RECENT_MAX_ENTRIES));
  const searched = filterEntries(scan.entries, { query });
  const matched = reviewStatus ? searched.map((entry) => ({ ...entry, review: reviewStatus(entry) })) : searched;
  const shown = filterEntries(matched, { group, needsReview });
  const terms = queryTerms(query ?? "");
  const unsupported = shown.length === 0 && terms.length > 0
    ? scan.unsupported.filter((path) => matchesQuery(path, terms)).slice(0, MAX_UNSUPPORTED_SHOWN)
    : [];
  return {
    ...(unsupported.length > 0 ? { unsupported } : {}),
    entries: shown.slice(0, cap),
    truncated: !scan.complete || shown.length > cap,
    counts: countGroups(matched),
    needsReview: filterEntries(matched, { needsReview: true }).length,
  };
}

// Called after a review mark changes, so the list does not show a reused scan's older revision.
export function forgetScan(root: string): void {
  scans.delete(root);
}

// Cheap probe for the header button: the same rules as the list, stopping at the first match.
export async function hasDocuments(root: string): Promise<boolean> {
  return (await scanWorkspace(root, 1)).entries.length > 0;
}

function sharedScan(root: string): Promise<Scan> {
  const started = Date.now();
  for (const [key, cached] of scans) if (cached.expiresAt <= started) scans.delete(key);
  const hit = scans.get(root);
  if (hit) return hit.result;
  const cached = { result: scanWorkspace(root), expiresAt: Number.POSITIVE_INFINITY };
  scans.set(root, cached);
  cached.result.then(
    () => {
      const finished = Date.now();
      cached.expiresAt = finished + Math.max(MIN_REUSE_MS, REUSE_FACTOR * (finished - started));
    },
    () => {
      if (scans.get(root) === cached) scans.delete(root);
    },
  );
  return cached.result;
}

async function scanWorkspace(root: string, stopAfter = Number.POSITIVE_INFINITY): Promise<Scan> {
  const found: RecentEntry[] = [];
  const unsupported: string[] = [];
  const queue = new Queue();
  queue.push({ path: root, depth: 0, mtimeMs: Number.POSITIVE_INFINITY, deferred: false });
  let visited = 0;
  let complete = true;

  while (queue.size > 0 && visited < RECENT_MAX_SCANNED_ENTRIES) {
    const { path: directory, depth, deferred } = queue.pop();
    let entries;
    try {
      entries = await opendir(directory, { bufferSize: 256 });
    } catch {
      continue;
    }
    let read = 0;
    for await (const item of entries) {
      if (++read > MAX_DIRECTORY_ENTRIES || ++visited > RECENT_MAX_SCANNED_ENTRIES) {
        complete = false;
        break;
      }
      const full = join(directory, item.name);
      if (item.isDirectory()) {
        if (item.name.startsWith(".") || SKIPPED_DIRECTORIES.has(item.name)) continue;
        if (depth >= MAX_DEPTH) {
          complete = false;
          continue;
        }
        try {
          queue.push({
            path: full,
            depth: depth + 1,
            mtimeMs: (await stat(full)).mtimeMs,
            deferred: deferred || DEFERRED_DIRECTORIES.has(item.name),
          });
        } catch {
          continue;
        }
        continue;
      }
      if (!item.isFile() || SKIPPED_FILE_PREFIXES.some((prefix) => item.name.startsWith(prefix))) continue;
      const kind = kindForPath(item.name);
      if (!kind) {
        if (!item.name.startsWith(".") && unsupported.length < MAX_UNSUPPORTED_NAMES) unsupported.push(relative(root, full).split(sep).join("/"));
        continue;
      }
      try {
        const info = await stat(full);
        found.push({ path: relative(root, full).split(sep).join("/"), kind, mtimeMs: info.mtimeMs, size: info.size, revision: revisionOf(info) });
        if (found.length >= stopAfter) return { entries: found, unsupported, complete: false };
      } catch {
        continue;
      }
    }
  }
  if (queue.size > 0) complete = false;
  return { entries: newestFirst(found), unsupported, complete };
}
