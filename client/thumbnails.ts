import { ERROR_MESSAGES, isError } from "../shared/errors";
import { KIND_REGISTRY, type DocumentKind } from "../shared/kinds";
import type { DocThumbnailOutput } from "../shared/rpc";
import { THUMBNAIL_MAX_WIDTH_PX, THUMBNAIL_MIN_WIDTH_PX } from "../shared/limits";

type EncodedImage = Extract<DocThumbnailOutput, { kind: "pdf" }>["image"];

export type Thumbnail =
  | { type: "image"; image: EncodedImage; count?: number }
  | { type: "title"; title: string; count?: number };

export interface ThumbnailAnswer {
  revision: string;
  thumbnail: Thumbnail;
}

export function thumbnailAnswer(output: DocThumbnailOutput): ThumbnailAnswer {
  const { revision } = output;
  if (output.kind === "pdf") return { revision, thumbnail: { type: "image", image: output.image, count: output.pageCount } };
  if (output.kind !== "pptx") return { revision, thumbnail: { type: "image", image: output.image } };
  const { preview, slideCount: count } = output;
  return { revision, thumbnail: preview.type === "image" ? { type: "image", image: preview.image, count } : { type: "title", title: preview.title, count } };
}

export type ThumbnailState =
  | { status: "loading" }
  | { status: "ready"; thumbnail: Thumbnail }
  | { status: "stale" }
  | { status: "failed"; error: unknown };

const GAP = 12;
const PHONE_GAP = 8;
const LABEL_HEIGHT = 22;
const DESKTOP_CELL = 150;
const PAGE_ASPECT = 1.3;
const WIDTH_STEP = 40;
const MAX_IN_FLIGHT = 2;

export function gridLayout(width: number, compact: boolean) {
  const gap = compact ? PHONE_GAP : GAP;
  const columns = compact
    ? width >= 300 ? 3 : 2
    : Math.min(8, Math.max(3, Math.round((width + gap) / (DESKTOP_CELL + gap))));
  const cellWidth = Math.max(1, (width - gap * (columns - 1)) / columns);
  const imageHeight = Math.round(cellWidth * PAGE_ASPECT);
  return { columns, gap, cellWidth, imageHeight, rowHeight: imageHeight + LABEL_HEIGHT + gap };
}

// Pages drawn with a password are kept apart: a turn card keeps the icon for a file that needs one.
export const pageThumbnailKey = (workspaceId: string, path: string, width: number, index: number, unlocked = false) =>
  `${workspaceId}\0${path}\0${width}\0${index}${unlocked ? "\0unlocked" : ""}`;

// A few fixed widths keep the shared cache useful across small layout changes.
export function thumbnailWidth(cellWidth: number, pixelRatio: number): number {
  const stepped = Math.ceil((cellWidth * pixelRatio) / WIDTH_STEP) * WIDTH_STEP;
  return Math.min(THUMBNAIL_MAX_WIDTH_PX, Math.max(THUMBNAIL_MIN_WIDTH_PX, stepped));
}

export function visibleOrder({ columns, rowHeight, offset, viewport, count }: { columns: number; rowHeight: number; offset: number; viewport: number; count: number }): number[] {
  const rows = Math.ceil(count / columns);
  if (rows === 0) return [];
  const clampRow = (row: number, min: number) => Math.min(rows - 1, Math.max(min, row));
  const first = clampRow(Math.floor(Math.max(0, offset) / rowHeight), 0);
  const last = clampRow(Math.ceil((offset + viewport) / rowHeight) - 1, first);
  const order: number[] = [];
  const add = (row: number) => {
    if (row < 0 || row >= rows) return;
    for (let index = row * columns; index < Math.min(count, (row + 1) * columns); index++) order.push(index);
  };
  for (let row = first; row <= last; row++) add(row);
  if (viewport > 0) {
    add(last + 1);
    add(first - 1);
  }
  return order;
}

export const hasThumbnail = (kind: DocumentKind) => KIND_REGISTRY[kind].rpcs.includes("doc.thumbnail");

export interface ThumbnailCache {
  get(key: string): Thumbnail | undefined;
  set(key: string, thumbnail: Thumbnail): void;
}

// Plain closures instead of classes: Paseo's Hermes client bundle cannot load class syntax.
export function createThumbnailCache(maxEntries: number, maxBytes: number): ThumbnailCache {
  const entries = new Map<string, Thumbnail>();
  const sizeOf = (thumbnail: Thumbnail) => (thumbnail.type === "image" ? thumbnail.image.data.length : thumbnail.title.length * 2);
  let bytes = 0;
  return {
    get(key) {
      const thumbnail = entries.get(key);
      if (thumbnail) {
        entries.delete(key);
        entries.set(key, thumbnail);
      }
      return thumbnail;
    },
    set(key, thumbnail) {
      if (sizeOf(thumbnail) > maxBytes) return;
      const previous = entries.get(key);
      if (previous) {
        bytes -= sizeOf(previous);
        entries.delete(key);
      }
      entries.set(key, thumbnail);
      bytes += sizeOf(thumbnail);
      for (const [oldest, value] of entries) {
        if (entries.size <= maxEntries && bytes <= maxBytes) break;
        entries.delete(oldest);
        bytes -= sizeOf(value);
      }
    },
  };
}

export const thumbnailCache = createThumbnailCache(400, 12 * 1024 * 1024);

export interface ThumbnailLoader {
  state(index: number): ThumbnailState | undefined;
  want(indices: readonly number[]): void;
  retry(index: number): void;
  subscribe(listener: () => void): () => void;
  close(): void;
}

// One loader per open grid or card. Closing it stops new requests; answers already on the way only fill the cache.
export function createThumbnailLoader({ identify, cache, fetch, retryAfter }: {
  identify(index: number): { key: string; revision: string };
  cache: ThumbnailCache;
  fetch(index: number): Promise<ThumbnailAnswer>;
  retryAfter?(error: unknown, failures: number): number | null;
}): ThumbnailLoader {
  const states = new Map<number, ThumbnailState>();
  const failures = new Map<number, number>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const listeners = new Set<() => void>();
  let wanted: number[] = [];
  let inFlight = 0;
  let closed = false;
  const cacheKey = (index: number) => {
    const { key, revision } = identify(index);
    return `${key}\0${revision}`;
  };

  const state = (index: number): ThumbnailState | undefined => {
    const known = states.get(index);
    if (known) return known;
    const thumbnail = cache.get(cacheKey(index));
    return thumbnail ? { status: "ready", thumbnail } : undefined;
  };

  // A ready thumbnail lives in the shared cache; it is kept here only if the cache refused it.
  const settle = (index: number, settled: ThumbnailState | undefined) => {
    inFlight--;
    if (settled) states.set(index, settled);
    else states.delete(index);
    if (closed) return;
    for (const listener of listeners) listener();
    pump();
  };

  const start = (index: number) => {
    inFlight++;
    states.set(index, { status: "loading" });
    fetch(index).then(
      (answer) => {
        if (answer.revision !== identify(index).revision) return settle(index, { status: "stale" });
        cache.set(cacheKey(index), answer.thumbnail);
        settle(index, cache.get(cacheKey(index)) ? undefined : { status: "ready", thumbnail: answer.thumbnail });
      },
      (error: unknown) => {
        if (isError(error, ERROR_MESSAGES.fileChanged())) return settle(index, { status: "stale" });
        const failed = (failures.get(index) ?? 0) + 1;
        failures.set(index, failed);
        settle(index, { status: "failed", error });
        const delay = closed ? null : retryAfter?.(error, failed) ?? null;
        if (delay === null) return;
        const timer = setTimeout(() => {
          timers.delete(timer);
          loader.retry(index);
        }, delay);
        timers.add(timer);
      },
    );
  };

  const pump = () => {
    for (const index of wanted) {
      if (closed || inFlight >= MAX_IN_FLIGHT) return;
      if (state(index) === undefined) start(index);
    }
  };

  const loader: ThumbnailLoader = {
    state,
    want(indices) {
      wanted = [...indices];
      pump();
    },
    retry(index) {
      if (states.get(index)?.status !== "failed") return;
      states.delete(index);
      if (!wanted.includes(index)) wanted.unshift(index);
      pump();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close() {
      closed = true;
      wanted = [];
      listeners.clear();
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
    },
  };
  return loader;
}

export interface RequestQueue {
  run<T>(owner: object, priority: number, work: () => Promise<T>): Promise<T>;
  // Work of the owner not started yet is dropped and rejects; started work runs out.
  drop(owner: object): void;
}

// Runs at most `limit` requests at once across every owner, higher priority first, then in order.
// Starting waits a microtask, so owners created in the same render are ordered by priority.
export function createRequestQueue(limit: number): RequestQueue {
  const pending: { owner: object; priority: number; start(): void; cancel(): void }[] = [];
  let running = 0;
  let scheduled = false;
  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    void Promise.resolve().then(() => {
      scheduled = false;
      pump();
    });
  };
  const pump = () => {
    while (running < limit && pending.length > 0) {
      let best = 0;
      for (let i = 1; i < pending.length; i++) if (pending[i]!.priority > pending[best]!.priority) best = i;
      const [next] = pending.splice(best, 1);
      running++;
      next!.start();
    }
  };
  return {
    run(owner, priority, work) {
      return new Promise((resolve, reject) => {
        pending.push({
          owner,
          priority,
          start: () => {
            Promise.resolve().then(work).then(resolve, reject).then(() => {
              running--;
              pump();
            });
          },
          cancel: () => reject(new Error("Dropped from the request queue")),
        });
        schedule();
      });
    },
    drop(owner) {
      for (let i = pending.length - 1; i >= 0; i--) {
        if (pending[i]!.owner !== owner) continue;
        const [dropped] = pending.splice(i, 1);
        dropped!.cancel();
      }
    },
  };
}
