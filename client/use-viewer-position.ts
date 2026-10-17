import { useRpc } from "@getpaseo/plugin/client";
import { useCallback, useEffect, useRef, useState } from "react";
import { viewerStateReadRpc, viewerStateWriteRpc } from "../shared/rpc";
import type { ViewerPosition } from "../shared/viewer-state";

// Mount once per document identity. Persistence is best-effort and never blocks reading.
export function useViewerPosition(workspaceId: string, path: string, revision: string) {
  const read = useRpc(viewerStateReadRpc);
  const write = useRpc(viewerStateWriteRpc);
  const [saved, setSaved] = useState<{ position: ViewerPosition; revision: string } | null | undefined>(undefined);
  const pending = useRef<{ position: ViewerPosition | null; revision: string } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const writable = useRef(false);
  const writer = useRef(write);
  writer.current = write;
  const flush = useCallback(() => {
    if (timer.current !== undefined) clearTimeout(timer.current);
    timer.current = undefined;
    const value = pending.current;
    pending.current = null;
    if (value) void writer.current({ workspaceId, path, ...value }).catch(() => {});
  }, [workspaceId, path]);
  useEffect(() => {
    let active = true;
    let settled = false;
    const timeout = setTimeout(() => {
      if (active && !settled) { settled = true; setSaved(null); }
    }, 1500);
    read({ workspaceId, path }).then(
      ({ saved: value }) => { if (active && !settled) { settled = true; clearTimeout(timeout); writable.current = true; setSaved(value); } },
      () => { if (active && !settled) { settled = true; clearTimeout(timeout); setSaved(null); } },
    );
    return () => { active = false; clearTimeout(timeout); flush(); };
  }, [workspaceId, path, read, flush]);

  const save = useCallback((position: ViewerPosition | null) => {
    if (saved === undefined || !writable.current) return;
    pending.current = { position, revision };
    if (timer.current !== undefined) clearTimeout(timer.current);
    timer.current = setTimeout(flush, 1000);
  }, [saved, revision, flush]);

  return {
    ready: saved !== undefined,
    initial: saved?.position ?? null,
    save,
  };
}
