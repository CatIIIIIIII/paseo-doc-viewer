import { useRpc } from "@getpaseo/plugin/client";
import { useToast } from "@getpaseo/plugin/client/react-native";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { errorText } from "../shared/errors";
import { viewerStatePinRpc, viewerStateReadRpc, viewerStateReviewRpc, type ViewerStateReadOutput } from "../shared/rpc";
import { viewerMarksQueryKey } from "./queries";

// Pins and the review mark for one document; positions keep their own read in useViewerPosition.
export function useViewerMarks(workspaceId: string, path: string) {
  const read = useRpc(viewerStateReadRpc);
  const pin = useRpc(viewerStatePinRpc);
  const review = useRpc(viewerStateReviewRpc);
  const queryClient = useQueryClient();
  const toast = useToast();
  const [saving, setSaving] = useState(false);
  const queryKey = viewerMarksQueryKey(workspaceId, path);
  const marks = useQuery({ queryKey, queryFn: () => read({ workspaceId, path }), staleTime: 10_000, retry: false });
  const merge = (change: Partial<ViewerStateReadOutput>) =>
    queryClient.setQueryData(queryKey, (current: ViewerStateReadOutput | undefined) => (current ? { ...current, ...change } : current));
  const saveWith = async (run: () => Promise<void>, fallback: string): Promise<boolean> => {
    setSaving(true);
    try {
      await run();
      return true;
    } catch (error) {
      toast.error(errorText(error) || fallback);
      return false;
    } finally {
      setSaving(false);
    }
  };
  return {
    pins: marks.data?.pins ?? [],
    review: marks.data?.review ?? null,
    ready: marks.data !== undefined,
    failed: marks.error !== null,
    saving,
    setPin: (index: number, value: { label?: string; revision: string } | null) =>
      saveWith(async () => {
        merge(await pin({ workspaceId, path, index, pin: value }));
      }, "Could not save the pin"),
    setReview: (revision: string | null) =>
      saveWith(async () => {
        const answer = await review({ workspaceId, path, revision });
        merge({ review: answer.review });
        void queryClient.invalidateQueries({ queryKey: ["docs.recent", workspaceId] });
        if (revision !== null && answer.revision !== revision) {
          void queryClient.invalidateQueries({ queryKey: ["doc.open", workspaceId, path] });
          toast.error("The file changed while it was open. Check the latest version, then mark it reviewed.");
        }
      }, "Could not save the review mark"),
  };
}
