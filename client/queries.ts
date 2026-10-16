export const REVISION_POLL_MS = 5_000;
export const RECENT_POLL_MS = 5_000;

export function documentQueryOptions(workspaceId: string, path: string) {
  return {
    queryKey: ["doc.open", workspaceId, path] as const,
    enabled: workspaceId !== "" && path !== "",
    refetchInterval: REVISION_POLL_MS,
    refetchOnWindowFocus: true,
  };
}

export function recentQueryOptions(workspaceId: string) {
  return {
    queryKey: ["docs.recent", workspaceId] as const,
    refetchInterval: RECENT_POLL_MS,
    refetchOnWindowFocus: true,
  };
}

export function pageQueryKey(workspaceId: string, path: string, revision: string, index: number, width: number | null) {
  return ["doc.page", workspaceId, path, revision, index, width] as const;
}

export function blocksQueryKey(workspaceId: string, path: string, revision: string) {
  return ["doc.blocks", workspaceId, path, revision] as const;
}

export function rowsQueryKey(
  workspaceId: string,
  path: string,
  revision: string,
  { sheet, rowOffset, columnOffset }: { sheet: number; rowOffset: number; columnOffset: number },
  maxColumns: number,
) {
  return ["doc.rows", workspaceId, path, revision, sheet, rowOffset, columnOffset, maxColumns] as const;
}
