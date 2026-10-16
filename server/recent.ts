import { opendir, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { RECENT_MAX_ENTRIES } from "../shared/limits";
import { kindForPath, type DocumentKind } from "../shared/kinds";

export interface RecentEntry {
  path: string;
  kind: DocumentKind;
  mtimeMs: number;
  size: number;
}

const SKIPPED_DIRECTORIES = new Set(["node_modules", "__pycache__", "venv", "target", "build", "dist", "vendor"]);
const SKIPPED_FILE_PREFIXES = ["~$", "._"];
const MAX_VISITED_ENTRIES = 50_000;
const MAX_DIRECTORY_ENTRIES = 5_000;
const MAX_DEPTH = 16;

interface Pending {
  path: string;
  depth: number;
  mtimeMs: number;
}

class NewestFirst {
  private heap: Pending[] = [];

  get size(): number {
    return this.heap.length;
  }

  push(item: Pending): void {
    const heap = this.heap;
    heap.push(item);
    for (let i = heap.length - 1; i > 0; ) {
      const parent = (i - 1) >> 1;
      if (heap[parent].mtimeMs >= heap[i].mtimeMs) break;
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
        let largest = i;
        if (left < heap.length && heap[left].mtimeMs > heap[largest].mtimeMs) largest = left;
        if (right < heap.length && heap[right].mtimeMs > heap[largest].mtimeMs) largest = right;
        if (largest === i) break;
        [heap[largest], heap[i]] = [heap[i], heap[largest]];
        i = largest;
      }
    }
    return top;
  }
}

export async function recentDocuments(
  root: string,
  limit: number = RECENT_MAX_ENTRIES,
): Promise<{ entries: RecentEntry[]; truncated: boolean }> {
  const found: RecentEntry[] = [];
  const queue = new NewestFirst();
  queue.push({ path: root, depth: 0, mtimeMs: Number.POSITIVE_INFINITY });
  let visited = 0;
  let complete = true;

  while (queue.size > 0 && visited < MAX_VISITED_ENTRIES) {
    const { path: directory, depth } = queue.pop();
    let entries;
    try {
      entries = await opendir(directory, { bufferSize: 256 });
    } catch {
      continue;
    }
    let read = 0;
    for await (const item of entries) {
      if (++read > MAX_DIRECTORY_ENTRIES || ++visited > MAX_VISITED_ENTRIES) {
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
          queue.push({ path: full, depth: depth + 1, mtimeMs: (await stat(full)).mtimeMs });
        } catch {
          continue;
        }
        continue;
      }
      if (!item.isFile() || SKIPPED_FILE_PREFIXES.some((prefix) => item.name.startsWith(prefix))) continue;
      const kind = kindForPath(item.name);
      if (!kind) continue;
      try {
        const info = await stat(full);
        found.push({ path: relative(root, full).split(sep).join("/"), kind, mtimeMs: info.mtimeMs, size: info.size });
      } catch {
        continue;
      }
    }
  }
  if (queue.size > 0) complete = false;
  found.sort((a, b) => b.mtimeMs - a.mtimeMs || a.path.localeCompare(b.path));
  const cap = Math.max(1, Math.min(limit, RECENT_MAX_ENTRIES));
  return { entries: found.slice(0, cap), truncated: found.length > cap || !complete };
}
