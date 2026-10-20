import { useRpc } from "@getpaseo/plugin/client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef } from "react";
import { DEFAULT_DOCUMENT_VIEW, type DocumentView, type DocumentViews } from "../shared/documents-view";
import { documentsViewReadRpc, documentsViewWriteRpc } from "../shared/rpc";
import type { LayoutClass } from "../shared/viewer-state";

const VIEW_QUERY_KEY = ["documents-view.read"] as const;

export const VIEW_OPTIONS: readonly { view: DocumentView; label: string; icon: string; spoken: string }[] = [
  { view: "list", label: "List", icon: "LayoutList", spoken: "List view" },
  { view: "details", label: "Details", icon: "List", spoken: "Details view" },
  { view: "previews", label: "Previews", icon: "LayoutGrid", spoken: "Preview view" },
  { view: "tree", label: "Tree", icon: "FolderTree", spoken: "Tree view" },
];

export function useDocumentView(layout: LayoutClass): [DocumentView, (view: DocumentView) => void] {
  const read = useRpc(documentsViewReadRpc);
  const write = useRpc(documentsViewWriteRpc);
  const queryClient = useQueryClient();
  const stored = useQuery({ queryKey: VIEW_QUERY_KEY, queryFn: () => read({}), staleTime: 60_000, retry: false });
  const view = stored.data?.views[layout] ?? DEFAULT_DOCUMENT_VIEW;
  // Writes go one at a time, and only the latest press applies its answer: a late answer to an earlier
  // press would otherwise switch the view back.
  const writes = useRef<Promise<unknown>>(Promise.resolve());
  const latest = useRef(0);
  const choose = (next: DocumentView) => {
    const choice = ++latest.current;
    const shown = queryClient.cancelQueries({ queryKey: VIEW_QUERY_KEY }).then(() => {
      queryClient.setQueryData(VIEW_QUERY_KEY, (current: { views: DocumentViews } | undefined) => ({ views: { ...current?.views, [layout]: next } }));
    });
    writes.current = Promise.all([writes.current, shown]).then(() => write({ layout, view: next })).then(
      (answer) => { if (choice === latest.current) queryClient.setQueryData(VIEW_QUERY_KEY, answer); },
      () => { if (choice === latest.current) void queryClient.invalidateQueries({ queryKey: VIEW_QUERY_KEY }); },
    );
  };
  return [view, choose];
}
