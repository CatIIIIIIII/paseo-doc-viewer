import type { PluginClientContext } from "@getpaseo/plugin/client";
import { viewerStateOpenedRevisionsRpc } from "../shared/rpc";

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

// Reads the revision each file was last opened at, and again when one of them is opened on this
// client. Only the latest read is passed on, and nothing after the returned stop.
export function watchOpenedRevisions(
  client: Pick<PluginClientContext, "rpc">,
  workspaceId: string,
  paths: readonly string[],
  onChange: (opened: Readonly<Record<string, string>>) => void,
  marks: OpenedMarks = openedMarks,
): () => void {
  if (paths.length === 0) return () => {};
  let latest = 0;
  const read = () => {
    const request = ++latest;
    client.rpc(viewerStateOpenedRevisionsRpc, { workspaceId, paths: [...paths] }).then(
      (answer) => { if (request === latest) onChange(answer.opened); },
      () => {},
    );
  };
  read();
  const stop = marks.subscribe((event) => {
    if (event.workspaceId === workspaceId && paths.includes(event.path)) read();
  });
  return () => {
    latest++;
    stop();
  };
}
