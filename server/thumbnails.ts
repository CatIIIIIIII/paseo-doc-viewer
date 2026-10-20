import { ERROR_MESSAGES, isError } from "../shared/errors";
import { createMemo } from "./cache";
import { heavy, type Lane } from "./heavy";

export type ThumbnailRequest = { index: number; width: number; keepOpen?: boolean; revision?: string };
type ThumbnailFile = { path: string; revision: string; passwordKey: string };

// A thumbnail not kept open is for a file nobody is reading; it waits behind the page map.
const thumbnailLane = (keepOpen: boolean | undefined): Lane => (keepOpen === false ? "idle" : "background");

// Thumbnails have a cache of their own, so a page map or a timeline of cards cannot evict the pages
// being read, and a card asking again, or another client, does not decode the file again.
const thumbnails = createMemo({ maxBytes: 16 * 1024 * 1024, maxEntries: 1024 });
// A file nobody is reading whose thumbnail ran out of time is not tried again at that revision: on a
// PDF each try ends by restarting PDFium, which drops the document open in the viewer.
const SLOW_THUMBNAILS_MAX = 256;
const slowThumbnails = new Set<string>();

export async function thumbnailCached<T>(file: ThumbnailFile, { index, width, keepOpen }: ThumbnailRequest, compute: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const slow = keepOpen === false ? `${file.path}\0${file.revision}` : null;
  if (slow !== null && slowThumbnails.has(slow)) throw new Error(ERROR_MESSAGES.tooSlow());
  try {
    return await thumbnails.memo({ path: file.path, revision: file.revision, name: `${index}\0${width}\0${file.passwordKey}` }, () =>
      heavy(compute, { lane: thumbnailLane(keepOpen) }));
  } catch (error) {
    if (slow !== null && isError(error, ERROR_MESSAGES.tooSlow())) {
      slowThumbnails.add(slow);
      if (slowThumbnails.size > SLOW_THUMBNAILS_MAX) slowThumbnails.delete(slowThumbnails.values().next().value!);
    }
    throw error;
  }
}
