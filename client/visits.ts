// When Documents was last opened, per host and workspace. The server records each visit and
// returns the previous one; the app reuses that answer for a while, so switching workspaces back
// and forth does not reset what counts as new. Like the review drafts it hangs off the global
// object, so a bundle re-evaluated on reconnect keeps it.

export const VISIT_REUSE_MS = 30 * 60_000;
const MAX_REMEMBERED_VISITS = 100;
const VISITS_KEY = Symbol.for("paseo-doc-viewer/documents-visits/v1");

export function createVisitMemory(now: () => number = Date.now) {
  const visits = new Map<string, { since: number | null; at: number }>();
  const running = new Map<string, Promise<number | null>>();
  const fresh = (scope: string) => {
    const visit = visits.get(scope);
    return visit && now() - visit.at < VISIT_REUSE_MS ? visit : undefined;
  };
  return {
    // The previous visit if this one was recorded recently, else undefined.
    peek: (scope: string): number | null | undefined => fresh(scope)?.since,
    // Records a visit unless one was recorded recently, and resolves to the visit before it.
    open(scope: string, record: () => Promise<number | null>): Promise<number | null> {
      const visit = fresh(scope);
      if (visit) return Promise.resolve(visit.since);
      const pending = running.get(scope);
      if (pending) return pending;
      const started = record().then(
        (since) => {
          visits.delete(scope);
          visits.set(scope, { since, at: now() });
          if (visits.size > MAX_REMEMBERED_VISITS) visits.delete(visits.keys().next().value!);
          running.delete(scope);
          return since;
        },
        (error: unknown) => {
          running.delete(scope);
          throw error;
        },
      );
      running.set(scope, started);
      return started;
    },
  };
}

export type VisitMemory = ReturnType<typeof createVisitMemory>;

export function sharedVisitMemory(global: object = globalThis): VisitMemory {
  const existing = Reflect.get(global, VISITS_KEY) as VisitMemory | undefined;
  if (existing) return existing;
  const memory = createVisitMemory();
  Reflect.set(global, VISITS_KEY, memory);
  return memory;
}

export const documentsVisits = sharedVisitMemory();
