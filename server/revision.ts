// Revisions describe file metadata only: a rewrite with identical size and times keeps its revision.
export function revisionOf(info: { size: number; mtimeMs: number; ctimeMs: number }): string {
  const stamp = (value: number) => Math.trunc(value * 1000).toString(36);
  return `${info.size.toString(36)}-${stamp(info.mtimeMs)}-${stamp(info.ctimeMs)}`;
}
