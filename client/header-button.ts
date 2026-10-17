import type { PluginButtonRegistration, PluginClientContext } from "@getpaseo/plugin/client";
import { DOCUMENTS_PANEL_ID } from "./recent";
import { docsRecentRpc } from "../shared/rpc";

// Slower than the panel's poll and longer than the server scan cache, so every
// known workspace costs one scan per interval. Failures back off up to the cap.
export const HEADER_POLL_MS = 30_000;
export const HEADER_POLL_MAX_MS = 5 * 60_000;

type HeaderButtonHost = Pick<PluginClientContext, "paseo" | "rpc" | "addHeaderButton" | "openPanel">;

export function addDocumentsHeaderButtons(client: HeaderButtonHost): () => void {
  const buttons = new Map<string, PluginButtonRegistration>();
  const workspaces = new Map<string, { timer?: ReturnType<typeof setTimeout> }>();
  let stopped = false;
  let stop = () => {};

  const add = (workspaceId: string) => {
    if (buttons.has(workspaceId)) return;
    const registration = client.addHeaderButton({
      id: "documents",
      workspaceId,
      button: {
        title: "Show documents",
        icon: "FileStack",
        label: "Documents",
        behavior: { kind: "action", onPress: () => client.openPanel(DOCUMENTS_PANEL_ID, { workspaceId }) },
      },
    });
    buttons.set(workspaceId, registration);
  };
  const remove = (workspaceId: string) => {
    buttons.get(workspaceId)?.remove();
    buttons.delete(workspaceId);
  };
  const forget = (workspaceId: string) => {
    const state = workspaces.get(workspaceId);
    if (state?.timer !== undefined) clearTimeout(state.timer);
    workspaces.delete(workspaceId);
    remove(workspaceId);
  };
  const observe = (workspaceId: string) => {
    if (workspaces.has(workspaceId)) return;
    const state: { timer?: ReturnType<typeof setTimeout> } = {};
    let delay = HEADER_POLL_MS;
    workspaces.set(workspaceId, state);
    const current = () => !stopped && workspaces.get(workspaceId) === state;
    const refresh = async () => {
      try {
        const { entries } = await client.rpc(docsRecentRpc, { workspaceId, limit: 1 });
        if (!current()) return;
        if (entries.length > 0) add(workspaceId);
        else remove(workspaceId);
        delay = HEADER_POLL_MS;
      } catch {
        // Keep the last known state during a failure; retry later.
        delay = Math.min(delay * 2, HEADER_POLL_MAX_MS);
      } finally {
        if (current()) state.timer = setTimeout(() => void refresh(), delay);
      }
    };
    void refresh();
  };

  client.paseo.workspaces
    .list({ subscribe: {} })
    .then(({ subscription }) => {
      if (stopped) {
        void subscription.release();
        return;
      }
      const unsubscribe = subscription.subscribe({
        snapshot: ({ entries }) => {
          const ids = new Set(entries.map((workspace) => workspace.id));
          for (const id of [...workspaces.keys()]) if (!ids.has(id)) forget(id);
          for (const id of ids) observe(id);
        },
        update: (message) => {
          if (message.type !== "workspace_update") return;
          const update = message.payload;
          if (update.kind === "upsert") observe(update.workspace.id);
          else forget(update.id);
        },
      });
      stop = () => {
        unsubscribe();
        void subscription.release();
      };
    })
    .catch((error: unknown) => {
      if (!stopped) console.warn("Documents header button: workspace list unavailable", error);
    });

  return () => {
    stopped = true;
    stop();
    for (const id of [...workspaces.keys()]) forget(id);
  };
}
