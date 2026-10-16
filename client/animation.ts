import type { DocOpenOutput, MediaChunkOutput } from "../shared/rpc";
import { encodeBase64, loadMedia } from "./media";

export type ImageAnimation = NonNullable<Extract<DocOpenOutput, { kind: "image-raster" | "image-decoded" }>["animation"]>;

type AnimationMimeType = ImageAnimation["mimeType"];

// React Native's Image animates GIF on iOS (RCTGIFImageDecoder) and on Android (the Expo template links
// fresco animated-gif), but not WebP (expo.webp.animated is off on Android, iOS has no animated WebP decoder),
// so the daemon transcodes animated WebP to GIF for them.
const PLAYED_AS: Readonly<Record<string, Partial<Record<AnimationMimeType, AnimationMimeType>>>> = {
  web: { "image/gif": "image/gif", "image/webp": "image/webp" },
  ios: { "image/gif": "image/gif", "image/webp": "image/gif" },
  android: { "image/gif": "image/gif", "image/webp": "image/gif" },
};

export function animationFormat(os: string, mimeType: AnimationMimeType): AnimationMimeType | null {
  return PLAYED_AS[os]?.[mimeType] ?? null;
}

export async function loadAnimation(
  fetchChunk: (request: { offset: number; length: number }) => Promise<MediaChunkOutput>,
  revision: string,
): Promise<string> {
  const media = await loadMedia(fetchChunk);
  if (media.revision !== revision) throw new Error("The image changed while loading");
  return `data:${media.mimeType};base64,${encodeBase64(media.parts)}`;
}
