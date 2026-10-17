import { useRpc } from "@getpaseo/plugin/client";
import { useToast } from "@getpaseo/plugin/client/react-native";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { errorText } from "../shared/errors";
import { viewerStatePinRpc, viewerStateReadRpc } from "../shared/rpc";
import { pinsQueryKey } from "./queries";

export function usePins(workspaceId: string, path: string) {
  const read = useRpc(viewerStateReadRpc);
  const pin = useRpc(viewerStatePinRpc);
  const queryClient = useQueryClient();
  const toast = useToast();
  const [saving, setSaving] = useState(false);
  const queryKey = pinsQueryKey(workspaceId, path);
  const pins = useQuery({ queryKey, queryFn: async () => (await read({ workspaceId, path })).pins, staleTime: 10_000, retry: false });
  const change = async (index: number, value: { label?: string; revision: string } | null): Promise<boolean> => {
    setSaving(true);
    try {
      const { pins: next } = await pin({ workspaceId, path, index, pin: value });
      queryClient.setQueryData(queryKey, next);
      return true;
    } catch (error) {
      toast.error(errorText(error) || "Could not save the pin");
      return false;
    } finally {
      setSaving(false);
    }
  };
  return { pins: pins.data ?? [], ready: pins.data !== undefined, failed: pins.error !== null, saving, change };
}
