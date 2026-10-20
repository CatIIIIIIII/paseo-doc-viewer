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

export function estimateBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value) ?? "", "utf8");
}

// Least recently used, bounded by entries and bytes; a file's entries for older revisions are dropped
// once a newer revision is asked for. Failed computations are not kept.
export function createMemo({ maxBytes, maxEntries }: { maxBytes: number; maxEntries: number }) {
  const entries = new Map<string, Entry>();
  const revisions = new Map<string, string>();
  let totalBytes = 0;

  const remove = (key: string, entry: Entry) => {
    if (entries.get(key) !== entry) return;
    entries.delete(key);
    totalBytes -= entry.bytes;
  };

  const evict = (keep: string) => {
    for (const [key, entry] of entries) {
      if (totalBytes <= maxBytes && entries.size <= maxEntries) return;
      if (key !== keep) remove(key, entry);
    }
  };

  const dropOtherRevisions = (path: string, revision: string) => {
    if (revisions.get(path) === revision) return;
    revisions.set(path, revision);
    for (const [key, entry] of entries) if (entry.path === path && !key.startsWith(`${path}\0${revision}\0`)) remove(key, entry);
  };

  return {
    keys: (): string[] => [...entries.keys()],
    memo<T>(key: CacheKey, compute: () => Promise<T>, sizeOf: (value: T) => number = estimateBytes): Promise<T> {
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
          if (bytes > maxBytes) {
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
    },
  };
}

const shared = createMemo({ maxBytes: 128 * 1024 * 1024, maxEntries: 256 });

export const memo = shared.memo;
export const cacheKeys = shared.keys;
