const MAX_CACHE_BYTES = 128 * 1024 * 1024;
const MAX_CACHE_ENTRIES = 256;

export interface CacheKey {
  path: string;
  revision: string;
  name: string;
}

interface Entry {
  path: string;
  value: Promise<unknown>;
  bytes: number;
}

const entries = new Map<string, Entry>();
const revisions = new Map<string, string>();
let totalBytes = 0;

function remove(key: string, entry: Entry): void {
  if (entries.get(key) !== entry) return;
  entries.delete(key);
  totalBytes -= entry.bytes;
}

function evict(keep: string): void {
  for (const [key, entry] of entries) {
    if (totalBytes <= MAX_CACHE_BYTES && entries.size <= MAX_CACHE_ENTRIES) return;
    if (key !== keep) remove(key, entry);
  }
}

function dropOtherRevisions(path: string, revision: string): void {
  if (revisions.get(path) === revision) return;
  revisions.set(path, revision);
  for (const [key, entry] of entries) if (entry.path === path && !key.startsWith(`${path}\0${revision}\0`)) remove(key, entry);
}

export function estimateBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value) ?? "", "utf8");
}

export function cacheKeys(): string[] {
  return [...entries.keys()];
}

export function memo<T>(key: CacheKey, compute: () => Promise<T>, sizeOf: (value: T) => number = estimateBytes): Promise<T> {
  const id = `${key.path}\0${key.revision}\0${key.name}`;
  const hit = entries.get(id);
  if (hit) {
    entries.delete(id);
    entries.set(id, hit);
    return hit.value as Promise<T>;
  }
  dropOtherRevisions(key.path, key.revision);
  const entry: Entry = { path: key.path, value: compute(), bytes: 0 };
  entries.set(id, entry);
  entry.value.then(
    (value) => {
      if (entries.get(id) !== entry) return;
      const bytes = sizeOf(value as T);
      if (bytes > MAX_CACHE_BYTES) {
        remove(id, entry);
        return;
      }
      entry.bytes = bytes;
      totalBytes += bytes;
      evict(id);
    },
    () => remove(id, entry),
  );
  return entry.value as Promise<T>;
}
