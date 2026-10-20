const stamp = (value: number) => Math.trunc(value * 1000).toString(36);

export function documentRevision(size: number, mtimeMs: number, ctimeMs: number): string {
  return `${size.toString(36)}-${stamp(mtimeMs)}-${stamp(ctimeMs)}`;
}

export function revisionModifiedAt(revision: string): number | null {
  const parts = revision.split("-");
  if (parts.length !== 3 || !/^[0-9a-z]+$/.test(parts[1]!)) return null;
  return Math.trunc(parseInt(parts[1]!, 36) / 1000);
}

// max(mtime, ctime), like the turn card's change detection: a copy or move that keeps an old mtime
// still has a new ctime.
export function revisionChangedAt(revision: string): number | null {
  const parts = revision.split("-");
  if (parts.length !== 3 || !parts.slice(1).every((part) => /^[0-9a-z]+$/.test(part))) return null;
  return Math.trunc(Math.max(parseInt(parts[1]!, 36), parseInt(parts[2]!, 36)) / 1000);
}

export function revisionSize(revision: string): number | null {
  const parts = revision.split("-");
  if (parts.length !== 3 || !/^[0-9a-z]+$/.test(parts[0]!)) return null;
  return parseInt(parts[0]!, 36);
}
