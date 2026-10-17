import type { PluginButtonRegistration, PluginClientContext } from "@getpaseo/plugin/client";
import { DOCUMENTS_PANEL_ID } from "./recent";
import { docsAnyRpc } from "../shared/rpc";

// The SDK does not say which workspaces are on screen, so every known workspace is
// probed with docs.any, which stops at the first document, a few at a time.
// Failures back off up to the cap.
export const HEADER_POLL_MS = 2 * 60_000;
export const HEADER_POLL_MAX_MS = 10 * 60_000;
const MAX_CONCURRENT_PROBES = 2;

type HeaderButtonHost = Pick<PluginClientContext, "paseo" | "rpc" | "addHeaderButton" | "openPanel">;

export function addDocumentsHeaderButtons(client: HeaderButtonHost): () => void {
  const buttons = new Map<string, PluginButtonRegistration>();
  const workspaces = new Map<string, { timer?: ReturnType<typeof setTimeout> }>();
  let stopped = false;
  let stop = () => {};
  let probing = 0;
  const queued: (() => void)[] = [];
  const probe = async <T>(work: () => Promise<T>): Promise<T> => {
    if (probing < MAX_CONCURRENT_PROBES) probing++;
    else await new Promise<void>((start) => queued.push(start));
    try {
      return await work();
    } finally {
      const next = queued.shift();
      if (next) next();
      else probing--;
    }
  };

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
        const found = await probe(async () => (current() ? (await client.rpc(docsAnyRpc, { workspaceId })).found : null));
        if (found === null || !current()) return;
        if (found) add(workspaceId);
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
