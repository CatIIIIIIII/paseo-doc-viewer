const stamp = (value: number) => Math.trunc(value * 1000).toString(36);

export function documentRevision(size: number, mtimeMs: number, ctimeMs: number): string {
  return `${size.toString(36)}-${stamp(mtimeMs)}-${stamp(ctimeMs)}`;
}

export function revisionModifiedAt(revision: string): number | null {
  const parts = revision.split("-");
  if (parts.length !== 3 || !/^[0-9a-z]+$/.test(parts[1]!)) return null;
  return Math.trunc(parseInt(parts[1]!, 36) / 1000);
}

export function revisionSize(revision: string): number | null {
  const parts = revision.split("-");
  if (parts.length !== 3 || !/^[0-9a-z]+$/.test(parts[0]!)) return null;
  return parseInt(parts[0]!, 36);
}
