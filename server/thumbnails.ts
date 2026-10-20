import { ERROR_MESSAGES } from "../shared/errors";
import { createMemo } from "./cache";
import { heavy, type Lane } from "./heavy";
import { pdfiumRestartedBy } from "./pdfium";

export type ThumbnailRequest = { index: number; width: number; keepOpen?: boolean; revision?: string };
type ThumbnailFile = { path: string; revision: string; passwordKey: string };

// A thumbnail not kept open is for a file nobody is reading; it waits behind the page map.
const thumbnailLane = (keepOpen: boolean | undefined): Lane => (keepOpen === false ? "idle" : "background");

// Thumbnails have a cache of their own, so a page map or a timeline of cards cannot evict the pages
// being read, and a card asking again, or another client, does not decode the file again.
const thumbnails = createMemo({ maxBytes: 16 * 1024 * 1024, maxEntries: 1024 });
export const thumbnailCacheKeys = thumbnails.keys;
// A card thumbnail whose PDFium call was still running at its deadline is not tried again at that
// revision for a while: each try would end by restarting PDFium, which drops the document open in the
// viewer. Time that ran out while the call waited, for a slot or behind other PDFium calls, says
// nothing about the file and restarts nothing.
export const SLOW_THUMBNAIL_MS = 10 * 60_000;
const SLOW_THUMBNAILS_MAX = 256;
const slowUntil = new Map<string, number>();

function markSlow(key: string): void {
  slowUntil.delete(key);
  slowUntil.set(key, Date.now() + SLOW_THUMBNAIL_MS);
  if (slowUntil.size > SLOW_THUMBNAILS_MAX) slowUntil.delete(slowUntil.keys().next().value!);
}

export async function thumbnailCached<T>(file: ThumbnailFile, { index, width, keepOpen }: ThumbnailRequest, compute: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const slow = keepOpen === false ? `${file.path}\0${file.revision}` : null;
  if (slow !== null && (slowUntil.get(slow) ?? 0) > Date.now()) throw new Error(ERROR_MESSAGES.tooSlow());
  return thumbnails.memo({ path: file.path, revision: file.revision, name: `${index}\0${width}\0${file.passwordKey}` }, () =>
    heavy(async (signal) => {
      try {
        return await compute(signal);
      } catch (error) {
        if (slow !== null && pdfiumRestartedBy(signal)) markSlow(slow);
        throw error;
      }
    }, { lane: thumbnailLane(keepOpen) }));
}
