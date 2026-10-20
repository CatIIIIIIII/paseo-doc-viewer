import type { PluginClientContext } from "@getpaseo/plugin/client";
import { docThumbnailRpc } from "../shared/rpc";
import type { TurnDocs } from "../shared/turn-docs";
import { createRequestQueue, createThumbnailLoader, pageThumbnailKey, type RequestQueue, thumbnailCache, type ThumbnailLoader } from "./thumbnails";
import { cardThumbnail, cardThumbnailRetry, TURN_THUMBNAIL_WIDTH } from "./turn-docs";

// Every card of this client shares two requests, so a timeline of cards stays within what the
// daemon queues for files nobody is reading, however many cards there are.
export const CARD_THUMBNAILS_IN_FLIGHT = 2;
export const cardThumbnailQueue = createRequestQueue(CARD_THUMBNAILS_IN_FLIGHT);
let mounted = 0;

// One per mounted card. A card mounted later goes first: the timeline mounts the cards scrolled into view.
export function createCardThumbnails(
  client: Pick<PluginClientContext, "rpc">,
  { workspaceId, files }: Pick<TurnDocs, "workspaceId" | "files">,
  queue: RequestQueue = cardThumbnailQueue,
): ThumbnailLoader {
  const owner = {};
  const priority = ++mounted;
  const width = TURN_THUMBNAIL_WIDTH;
  const loader = createThumbnailLoader({
    identify: (index) => ({ key: pageThumbnailKey(workspaceId, files[index]!.path, width, 0), revision: files[index]!.revision }),
    cache: thumbnailCache,
    fetch: (index) => queue.run(owner, priority, () =>
      client.rpc(docThumbnailRpc, { workspaceId, path: files[index]!.path, index: 0, width, keepOpen: false, revision: files[index]!.revision })),
    retryAfter: cardThumbnailRetry,
  });
  loader.want(files.flatMap((file, index) => (cardThumbnail(file) ? [index] : [])));
  return {
    ...loader,
    close() {
      loader.close();
      queue.drop(owner);
    },
  };
}
