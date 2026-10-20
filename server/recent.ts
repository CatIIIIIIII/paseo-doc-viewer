import { opendir, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { countGroups, type BrowseFilter, type GroupCounts, filterEntries, matchesQuery, newestFirst, queryTerms, RECENT_CUTS, type RecentCut, type ReviewStatus, type ScanCut } from "../shared/browse";
import { RECENT_MAX_DEPTH, RECENT_MAX_ENTRIES, RECENT_MAX_FOLDER_ENTRIES, RECENT_MAX_LIMIT, RECENT_MAX_SCANNED_ENTRIES } from "../shared/limits";
import { kindForPath, type DocumentKind } from "../shared/kinds";
import type { ScannedFolders } from "../shared/turn-docs";
import { revisionOf } from "./revision";

export interface RecentEntry {
  path: string;
  kind: DocumentKind;
  mtimeMs: number;
  size: number;
  revision: string;
  // The later of the modified and status-change times, so a copied or moved file counts as new.
  changedMs: number;
  review?: ReviewStatus;
  isNew?: boolean;
}

const SKIPPED_DIRECTORIES = new Set(["node_modules", "__pycache__", "venv", "target", "vendor"]);
const DEFERRED_DIRECTORIES = new Set(["build", "dist", "out"]);
const SKIPPED_FILE_PREFIXES = ["~$", "._"];
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

interface Scan extends ScannedFolders {
  entries: RecentEntry[];
  // Other files, so a search can say a file exists but is not a supported type.
  unsupported: string[];
  // Why the scan stopped short of the whole workspace, in RECENT_CUTS order; empty when it read everything.
  cuts: ScanCut[];
}

const MAX_UNSUPPORTED_NAMES = 10_000;
const MAX_UNSUPPORTED_SHOWN = 3;

const scans = new Map<string, { result: Promise<Scan>; expiresAt: number }>();

export async function recentDocuments(
  root: string,
  { limit = RECENT_MAX_ENTRIES, query, group, needsReview, newOnly, newSince }: BrowseFilter & { limit?: number; newSince?: number } = {},
  marks?: (entry: RecentEntry) => { review?: ReviewStatus; opened: boolean } | undefined,
): Promise<{ entries: RecentEntry[]; truncatedBy: RecentCut[]; counts: GroupCounts; needsReview: number; newCount: number; unsupported?: string[] }> {
  const scan = await sharedScan(root);
  const cap = Math.max(1, Math.min(limit, RECENT_MAX_LIMIT));
  const searched = filterEntries(scan.entries, { query });
  // New: changed since the previous Documents visit, never reviewed, and not opened at this revision.
  const matched = marks || newSince !== undefined
    ? searched.map((entry) => {
        const { review, opened = false } = marks?.(entry) ?? {};
        return { ...entry, review, isNew: newSince !== undefined && review === undefined && !opened && entry.changedMs > newSince };
      })
    : searched;
  const shown = filterEntries(matched, { group, needsReview, newOnly });
  const terms = queryTerms(query ?? "");
  const unsupported = shown.length === 0 && terms.length > 0
    ? scan.unsupported.filter((path) => matchesQuery(path, terms)).slice(0, MAX_UNSUPPORTED_SHOWN)
    : [];
  return {
    ...(unsupported.length > 0 ? { unsupported } : {}),
    entries: shown.slice(0, cap),
    truncatedBy: [...(shown.length > cap ? ["limit" as const] : []), ...scan.cuts],
    counts: countGroups(matched),
    needsReview: filterEntries(matched, { needsReview: true }).length,
    newCount: filterEntries(matched, { newOnly: true }).length,
  };
}

// Called after a review or opened mark changes, so the list does not compare it with a reused scan's older revision.
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
  const dirs = new Map<string, number | null>();
  const repos = new Set<string>();
  const queue = new Queue();
  queue.push({ path: root, depth: 0, mtimeMs: Number.POSITIVE_INFINITY, deferred: false });
  let visited = 0;
  const cuts = new Set<ScanCut>();

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
      if (++read > RECENT_MAX_FOLDER_ENTRIES) {
        cuts.add("folder");
        break;
      }
      if (++visited > RECENT_MAX_SCANNED_ENTRIES) {
        cuts.add("entries");
        break;
      }
      const full = join(directory, item.name);
      // A worktree or submodule has a .git file, a clone a .git folder.
      if (item.name === ".git") repos.add(relativePath(root, directory));
      if (item.isDirectory()) {
        if (item.name.startsWith(".") || SKIPPED_DIRECTORIES.has(item.name)) continue;
        if (depth >= RECENT_MAX_DEPTH) {
          cuts.add("depth");
          continue;
        }
        try {
          const info = await stat(full);
          dirs.set(relativePath(root, full), folderBirthtime(info));
          queue.push({ path: full, depth: depth + 1, mtimeMs: info.mtimeMs, deferred: deferred || DEFERRED_DIRECTORIES.has(item.name) });
        } catch {
          continue;
        }
        continue;
      }
      if (!item.isFile() || SKIPPED_FILE_PREFIXES.some((prefix) => item.name.startsWith(prefix))) continue;
      const kind = kindForPath(item.name);
      if (!kind) {
        if (!item.name.startsWith(".") && unsupported.length < MAX_UNSUPPORTED_NAMES) unsupported.push(relativePath(root, full));
        continue;
      }
      try {
        const info = await stat(full);
        found.push({ path: relativePath(root, full), kind, mtimeMs: info.mtimeMs, size: info.size, revision: revisionOf(info), changedMs: Math.max(info.mtimeMs, info.ctimeMs) });
        if (found.length >= stopAfter) return { entries: found, unsupported, cuts: ["entries"], dirs, repos };
      } catch {
        continue;
      }
    }
  }
  if (queue.size > 0) cuts.add("entries");
  return { entries: newestFirst(found), unsupported, cuts: RECENT_CUTS.filter((cut): cut is ScanCut => cut !== "limit" && cuts.has(cut)), dirs, repos };
}

// Null when it cannot be told from a missing birth time, for which Node reports 0 or the change time.
// A real one can equal the change time too (coarse timestamps, or a folder untouched since it was made);
// taking it for unknown only skips a fold, and it matters only when a turn has no complete baseline.
export function folderBirthtime({ birthtimeMs, ctimeMs }: { birthtimeMs: number; ctimeMs: number }): number | null {
  return birthtimeMs > 0 && birthtimeMs < ctimeMs ? birthtimeMs : null;
}

function relativePath(root: string, full: string): string {
  return relative(root, full).split(sep).join("/");
}

// Supported documents and the folders the scan walked, for a turn's start and end. Always a new scan:
// one the Documents panel reused can predate a folder made just before the turn (git worktree add).
// The result replaces the cached scan, so the panel reuses it in turn.
export async function scannedDocuments(root: string): Promise<{ entries: readonly RecentEntry[]; complete: boolean } & ScannedFolders> {
  forgetScan(root);
  const { entries, cuts, dirs, repos } = await sharedScan(root);
  return { entries, complete: cuts.length === 0, dirs, repos };
}
