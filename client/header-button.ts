import type { PluginButtonRegistration, PluginClientContext } from "@getpaseo/plugin/client";
import { DOCUMENTS_PANEL_ID } from "./recent";

type HeaderButtonHost = Pick<PluginClientContext, "paseo" | "addHeaderButton" | "openPanel">;

export function addDocumentsHeaderButtons(client: HeaderButtonHost): () => void {
  const buttons = new Map<string, PluginButtonRegistration>();
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
          for (const id of [...buttons.keys()]) if (!ids.has(id)) remove(id);
          for (const id of ids) add(id);
        },
        update: (message) => {
          if (message.type !== "workspace_update") return;
          const update = message.payload;
          if (update.kind === "upsert") add(update.workspace.id);
          else remove(update.id);
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
    for (const id of [...buttons.keys()]) remove(id);
  };
}
