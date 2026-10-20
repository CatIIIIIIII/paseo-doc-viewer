// One store per plugin client, shared by its panel and document-opening actions.
// Keep the selected PDF when switching tabs or temporarily unmounting the panel.
export function createPanelReader() {
  const selected = new Map<string, string>();
  const listeners = new Set<() => void>();
  return {
    get: (workspaceId: string) => selected.get(workspaceId) ?? null,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    select(workspaceId: string, path: string | null) {
      if (path === null) selected.delete(workspaceId);
      else selected.set(workspaceId, path);
      for (const listener of listeners) listener();
    },
  };
}

export type PanelReader = ReturnType<typeof createPanelReader>;
