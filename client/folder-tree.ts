import { parentDir } from "./format";

export interface TreeFolder<T> {
  path: string;
  name: string;
  folders: TreeFolder<T>[];
  files: T[];
  count: number;
}

export type TreeRow<T> =
  | { type: "folder"; path: string; name: string; depth: number; count: number; expanded: boolean }
  | { type: "file"; entry: T; depth: number };

export interface TreeExpansion {
  base: "top" | "all" | "none";
  flipped: ReadonlySet<string>;
}

export const TOP_EXPANDED: TreeExpansion = { base: "top", flipped: new Set() };
export const ALL_EXPANDED: TreeExpansion = { base: "all", flipped: new Set() };
export const ALL_COLLAPSED: TreeExpansion = { base: "none", flipped: new Set() };

export function isExpanded(expansion: TreeExpansion, path: string, depth: number): boolean {
  const open = expansion.base === "all" || (expansion.base === "top" && depth === 0);
  return open !== expansion.flipped.has(path);
}

export function toggleFolder(expansion: TreeExpansion, path: string): TreeExpansion {
  const flipped = new Set(expansion.flipped);
  if (!flipped.delete(path)) flipped.add(path);
  return { base: expansion.base, flipped };
}

// By name, ignoring case; without Intl, which Hermes may lack.
function byName(a: string, b: string): number {
  const [x, y] = [a.toLowerCase(), b.toLowerCase()];
  return x < y ? -1 : x > y ? 1 : a < b ? -1 : a > b ? 1 : 0;
}

const nameOf = (path: string) => path.slice(path.lastIndexOf("/") + 1);

export function folderTree<T extends { path: string }>(entries: readonly T[]): TreeFolder<T> {
  type Building = { path: string; folders: Map<string, Building>; files: T[] };
  const root: Building = { path: "", folders: new Map(), files: [] };
  for (const entry of entries) {
    let node = root;
    for (const part of parentDir(entry.path).split("/").filter(Boolean)) {
      let next = node.folders.get(part);
      if (!next) {
        next = { path: node.path ? `${node.path}/${part}` : part, folders: new Map(), files: [] };
        node.folders.set(part, next);
      }
      node = next;
    }
    node.files.push(entry);
  }
  const finish = (node: Building): TreeFolder<T> => {
    const folders = [...node.folders.values()].map(finish).map(collapseChain).sort((a, b) => byName(a.name, b.name));
    const files = [...node.files].sort((a, b) => byName(nameOf(a.path), nameOf(b.path)));
    return { path: node.path, name: nameOf(node.path), folders, files, count: files.length + folders.reduce((sum, folder) => sum + folder.count, 0) };
  };
  return finish(root);
}

function collapseChain<T>(folder: TreeFolder<T>): TreeFolder<T> {
  let chained = folder;
  while (chained.files.length === 0 && chained.folders.length === 1) {
    const only = chained.folders[0]!;
    chained = { ...only, name: `${chained.name}/${only.name}` };
  }
  return chained;
}

export function treeRows<T>(root: TreeFolder<T>, expanded: (path: string, depth: number) => boolean): TreeRow<T>[] {
  const rows: TreeRow<T>[] = [];
  const walk = (node: TreeFolder<T>, depth: number) => {
    for (const folder of node.folders) {
      const open = expanded(folder.path, depth);
      rows.push({ type: "folder", path: folder.path, name: folder.name, depth, count: folder.count, expanded: open });
      if (open) walk(folder, depth + 1);
    }
    for (const entry of node.files) rows.push({ type: "file", entry, depth });
  };
  walk(root, 0);
  return rows;
}

export function folderFiles<T extends { path: string }>(rows: readonly TreeRow<T>[], path: string): string[] {
  const folder = parentDir(path);
  return rows.flatMap((row) => (row.type === "file" && parentDir(row.entry.path) === folder ? [row.entry.path] : []));
}
