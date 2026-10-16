import type { DocumentKind } from "./kinds";

export const DOCUMENT_GROUPS = ["pdf", "word", "excel", "powerpoint", "image", "video"] as const;
export type DocumentGroup = (typeof DOCUMENT_GROUPS)[number];
export type GroupCounts = Record<DocumentGroup, number>;

export const KIND_GROUP: { readonly [K in DocumentKind]: DocumentGroup } = {
  pdf: "pdf",
  docx: "word",
  xlsx: "excel",
  pptx: "powerpoint",
  "image-raster": "image",
  "image-decoded": "image",
  video: "video",
};

export interface BrowseEntry {
  path: string;
  kind: DocumentKind;
  mtimeMs: number;
}

export interface BrowseFilter {
  query?: string;
  group?: DocumentGroup | null;
}

export function queryTerms(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(Boolean);
}

export function matchesQuery(path: string, terms: readonly string[]): boolean {
  const haystack = path.toLowerCase();
  return terms.every((term) => haystack.includes(term));
}

export function filterEntries<T extends BrowseEntry>(entries: readonly T[], { query = "", group = null }: BrowseFilter): T[] {
  const terms = queryTerms(query);
  return entries.filter((entry) => (!group || KIND_GROUP[entry.kind] === group) && matchesQuery(entry.path, terms));
}

export function countGroups(entries: readonly Pick<BrowseEntry, "kind">[]): GroupCounts {
  const counts = Object.fromEntries(DOCUMENT_GROUPS.map((group) => [group, 0])) as GroupCounts;
  for (const entry of entries) counts[KIND_GROUP[entry.kind]] += 1;
  return counts;
}

export function newestFirst<T extends BrowseEntry>(entries: readonly T[]): T[] {
  return [...entries].sort((a, b) => b.mtimeMs - a.mtimeMs || a.path.localeCompare(b.path));
}

export function groupEntries<T extends BrowseEntry>(entries: readonly T[]): { group: DocumentGroup; entries: T[] }[] {
  const sorted = newestFirst(entries);
  return DOCUMENT_GROUPS.map((group) => ({ group, entries: sorted.filter((entry) => KIND_GROUP[entry.kind] === group) })).filter(
    (section) => section.entries.length > 0,
  );
}
