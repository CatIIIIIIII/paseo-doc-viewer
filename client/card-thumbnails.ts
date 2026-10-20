import type { PluginClientContext } from "@getpaseo/plugin/client";
import { docThumbnailRpc } from "../shared/rpc";
import type { TurnDocsFile } from "../shared/turn-docs";
import { createRequestQueue, createThumbnailLoader, pageThumbnailKey, type RequestQueue, thumbnailAnswer, thumbnailCache, type ThumbnailLoader } from "./thumbnails";
import { cardThumbnail, cardThumbnailRetry, TURN_THUMBNAIL_WIDTH } from "./turn-docs";

// Every card of this client shares one request, as the daemon draws one thumbnail at a time for files
// nobody is reading: a second request would only wait behind the first and give up while it decodes.
export const CARD_THUMBNAILS_IN_FLIGHT = 1;
export const cardThumbnailQueue = createRequestQueue(CARD_THUMBNAILS_IN_FLIGHT);
let mounted = 0;

// A card mounted later goes first: the timeline mounts the cards scrolled into view. A card keeps its
// priority when its files change, so it does not move ahead of cards mounted after it.
export const nextCardPriority = (): number => ++mounted;

// The indices in `files` of the listed rows that draw a thumbnail.
export const cardThumbnailIndices = (files: readonly TurnDocsFile[], listed: readonly TurnDocsFile[] = files) =>
  listed.map((file) => files.indexOf(file)).filter((index) => index >= 0 && cardThumbnail(files[index]!));

// One per mounted card and list of files; the card says which rows it wants.
export function createCardThumbnails(
  client: Pick<PluginClientContext, "rpc">,
  { workspaceId, files }: { workspaceId: string; files: readonly TurnDocsFile[] },
  priority = nextCardPriority(),
  queue: RequestQueue = cardThumbnailQueue,
): ThumbnailLoader {
  const owner = {};
  const width = TURN_THUMBNAIL_WIDTH;
  const loader = createThumbnailLoader({
    identify: (index) => ({ key: pageThumbnailKey(workspaceId, files[index]!.path, width, 0), revision: files[index]!.revision }),
    cache: thumbnailCache,
    fetch: (index) => queue.run(owner, priority, () =>
      client.rpc(docThumbnailRpc, { workspaceId, path: files[index]!.path, index: 0, width, keepOpen: false, revision: files[index]!.revision }).then(thumbnailAnswer)),
    retryAfter: cardThumbnailRetry,
  });
  return {
    ...loader,
    close() {
      loader.close();
      queue.drop(owner);
    },
  };
}
