import { parentDir } from "./format";

export interface TreeFolder<T> {
  path: string;
  name: string;
  // The folders one row stands for, outermost first: more than one when single-folder folders chain.
  chain: string[];
  folders: TreeFolder<T>[];
  files: T[];
  count: number;
}

export type TreeRow<T> =
  | { type: "folder"; path: string; name: string; parent: string; chain: readonly string[]; depth: number; count: number; expanded: boolean }
  | { type: "file"; entry: T; depth: number };

export interface TreeExpansion {
  base: "top" | "all" | "none";
  // Folders opened or closed by hand, and the folders of a chained row that opened by default. A chained
  // row sets every folder in it, so the state holds when an agent splits the chain with a new file or the
  // chain forms again.
  chosen: ReadonlyMap<string, boolean>;
}

export const TOP_EXPANDED: TreeExpansion = { base: "top", chosen: new Map() };
export const ALL_EXPANDED: TreeExpansion = { base: "all", chosen: new Map() };
export const ALL_COLLAPSED: TreeExpansion = { base: "none", chosen: new Map() };

// A chained row is open when every folder in it is, as the same folders would show unchained.
export function isExpanded(expansion: TreeExpansion, chain: readonly string[], depth: number): boolean {
  const open = expansion.base === "all" || (expansion.base === "top" && depth === 0);
  return chain.every((path) => expansion.chosen.get(path) ?? open);
}

export function setExpanded(expansion: TreeExpansion, chain: readonly string[], open: boolean): TreeExpansion {
  const chosen = new Map(expansion.chosen);
  for (const path of chain) chosen.set(path, open);
  return { base: expansion.base, chosen };
}

// Only the top level opens by default, so the folders of a chain that opened that way, once split, would
// leave all but the first closed. Choosing them keeps the chain open as it was.
export function holdOpenChains(expansion: TreeExpansion, rows: readonly TreeRow<unknown>[]): TreeExpansion {
  if (expansion.base !== "top") return expansion;
  let held = expansion;
  for (const row of rows) {
    if (row.type === "folder" && row.chain.length > 1 && row.expanded && row.chain.some((path) => !held.chosen.has(path))) held = setExpanded(held, row.chain, true);
  }
  return held;
}

// Open folders per host and workspace until the app restarts, up to `max` workspaces, the least
// recently used dropped first. A search or filter starts with every folder open, kept apart per scope.
export function treeExpansions(max: number) {
  const saved = new Map<string, TreeExpansion>();
  return {
    key: (scope: string, filterKey: string | null) => (filterKey === null ? scope : `${scope}\0${filterKey}`),
    start: (scope: string, filterKey: string | null) => (filterKey === null ? saved.get(scope) ?? TOP_EXPANDED : ALL_EXPANDED),
    save(scope: string, expansion: TreeExpansion) {
      saved.delete(scope);
      saved.set(scope, expansion);
      for (const oldest of saved.keys()) {
        if (saved.size <= max) break;
        saved.delete(oldest);
      }
    },
  };
}

const DIGITS = /(\d+)/;
const byText = (x: string, y: string) => (x < y ? -1 : x > y ? 1 : 0);

// Digit runs of any length compare by value, so run-2 sorts before run-10 without Number's precision limit.
function byNumber(x: string, y: string): number {
  const [p, q] = [x.replace(/^0+/, ""), y.replace(/^0+/, "")];
  return p.length - q.length || byText(p, q);
}

// By name, ignoring case, with numbers in order; without Intl, which Hermes may lack.
export function byName(a: string, b: string): number {
  const [x, y] = [a.toLowerCase().split(DIGITS), b.toLowerCase().split(DIGITS)];
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const order = i % 2 === 1 ? byNumber(x[i]!, y[i]!) : byText(x[i]!, y[i]!);
    if (order !== 0) return order;
  }
  return x.length - y.length || byText(a, b);
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
    return { path: node.path, name: nameOf(node.path), chain: [node.path], folders, files, count: files.length + folders.reduce((sum, folder) => sum + folder.count, 0) };
  };
  return finish(root);
}

function collapseChain<T>(folder: TreeFolder<T>): TreeFolder<T> {
  let chained = folder;
  while (chained.files.length === 0 && chained.folders.length === 1) {
    const only = chained.folders[0]!;
    chained = { ...only, name: `${chained.name}/${only.name}`, chain: [...chained.chain, ...only.chain] };
  }
  return chained;
}

export function treeRows<T>(root: TreeFolder<T>, expanded: (chain: readonly string[], depth: number) => boolean): TreeRow<T>[] {
  const rows: TreeRow<T>[] = [];
  const walk = (node: TreeFolder<T>, depth: number) => {
    for (const folder of node.folders) {
      const open = expanded(folder.chain, depth);
      rows.push({ type: "folder", path: folder.path, name: folder.name, parent: node.path, chain: folder.chain, depth, count: folder.count, expanded: open });
      if (open) walk(folder, depth + 1);
    }
    for (const entry of node.files) rows.push({ type: "file", entry, depth });
  };
  walk(root, 0);
  return rows;
}

// Names the folder and where it sits; `level` is spoken only where no tree role carries it.
export function folderLabel({ name, parent, count }: { name: string; parent: string; count: number }, level?: number): string {
  return [
    parent ? `${name}, folder in ${parent}` : `${name}, folder`,
    ...(level === undefined ? [] : [`level ${level}`]),
    `${count} ${count === 1 ? "document" : "documents"}`,
  ].join(", ");
}

export function folderFiles<T extends { path: string }>(rows: readonly TreeRow<T>[], path: string): string[] {
  const folder = parentDir(path);
  return rows.flatMap((row) => (row.type === "file" && parentDir(row.entry.path) === folder ? [row.entry.path] : []));
}
