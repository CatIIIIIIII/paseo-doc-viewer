// One store per plugin client, shared by its panel and document-opening actions.
// Keep the selected PDF when switching tabs or temporarily unmounting the panel.
// `siblings` is the encoded documentScreen param, so the embedded reader keeps Previous and Next.
export interface PanelSelection {
  path: string;
  siblings?: string;
}

export function createPanelReader() {
  const selected = new Map<string, PanelSelection>();
  const listeners = new Set<() => void>();
  return {
    get: (workspaceId: string) => selected.get(workspaceId) ?? null,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    select(workspaceId: string, selection: PanelSelection | null) {
      if (selection === null) selected.delete(workspaceId);
      else selected.set(workspaceId, selection);
      for (const listener of listeners) listener();
    },
  };
}

export type PanelReader = ReturnType<typeof createPanelReader>;
