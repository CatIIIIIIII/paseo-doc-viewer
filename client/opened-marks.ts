// Like the visits memory it hangs off the global object, so a bundle re-evaluated on reconnect keeps
// the cards' subscriptions.

export type OpenedEvent = { workspaceId: string; path: string };
type Listener = (event: OpenedEvent) => void;

const OPENED_KEY = Symbol.for("paseo-doc-viewer/opened-marks/v1");

export function createOpenedMarks() {
  const listeners = new Set<Listener>();
  return {
    notify(event: OpenedEvent): void {
      for (const listener of listeners) listener(event);
    },
    subscribe(listener: Listener): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

export type OpenedMarks = ReturnType<typeof createOpenedMarks>;

export function sharedOpenedMarks(global: object = globalThis): OpenedMarks {
  const existing = Reflect.get(global, OPENED_KEY) as OpenedMarks | undefined;
  if (existing) return existing;
  const marks = createOpenedMarks();
  Reflect.set(global, OPENED_KEY, marks);
  return marks;
}

export const openedMarks = sharedOpenedMarks();
