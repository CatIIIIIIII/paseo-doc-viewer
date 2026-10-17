import { type BrowseFilter, queryTerms } from "../shared/browse";
import type { DocsRecentInput, DocsRecentOutput } from "../shared/rpc";

export const REVISION_POLL_MS = 5_000;
export const RECENT_POLL_MS = 5_000;

// Without data, a refetch resets the query to pending, which would unmount the password prompt
// and drop what was typed, so a document that failed to open is only refetched on request.
const opened = (query: { state: { data: unknown } }) => query.state.data !== undefined;

export function documentQueryOptions(workspaceId: string, path: string, unlockAttempt = 0) {
  return {
    queryKey: ["doc.open", workspaceId, path, unlockAttempt] as const,
    enabled: workspaceId !== "" && path !== "",
    refetchInterval: (query: { state: { data: unknown } }) => (opened(query) ? REVISION_POLL_MS : false),
    refetchOnWindowFocus: opened,
  };
}

export function recentQueryOptions(workspaceId: string, filter: BrowseFilter) {
  const query = queryTerms(filter.query ?? "").join(" ");
  const group = filter.group ?? null;
  const needsReview = filter.needsReview ?? false;
  const request: DocsRecentInput = { workspaceId, ...(query ? { query } : {}), ...(group ? { group } : {}), ...(needsReview ? { needsReview } : {}) };
  return {
    queryKey: ["docs.recent", workspaceId, query, group, needsReview] as const,
    request,
    refetchInterval: RECENT_POLL_MS,
    refetchOnWindowFocus: true,
    placeholderData: (previous: DocsRecentOutput | undefined) => previous,
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

export function animationQueryKey(workspaceId: string, path: string, revision: string) {
  return ["media.chunk", workspaceId, path, revision] as const;
}

export function textQueryKey(workspaceId: string, path: string, revision: string, index: number) {
  return ["doc.text", workspaceId, path, revision, index] as const;
}

export function viewerMarksQueryKey(workspaceId: string, path: string) {
  return ["viewer-state.marks", workspaceId, path] as const;
}
