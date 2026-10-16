import type { DocOpenOutput, MediaChunkOutput } from "../shared/rpc";
import { encodeBase64, loadMedia } from "./media";

export type ImageAnimation = NonNullable<Extract<DocOpenOutput, { kind: "image-raster" | "image-decoded" }>["animation"]>;

// React Native's Image animates GIF on iOS (RCTGIFImageDecoder) and on Android (the Expo template links
// fresco animated-gif). Animated WebP needs expo.webp.animated on Android and is not decoded on iOS.
const ANIMATED_TYPES: Readonly<Record<string, readonly ImageAnimation["mimeType"][]>> = {
  web: ["image/gif", "image/webp"],
  ios: ["image/gif"],
  android: ["image/gif"],
};

export function playsAnimation(os: string, mimeType: ImageAnimation["mimeType"]): boolean {
  return ANIMATED_TYPES[os]?.includes(mimeType) ?? false;
}

export async function loadAnimation(
  fetchChunk: (request: { offset: number; length: number }) => Promise<MediaChunkOutput>,
  revision: string,
): Promise<string> {
  const media = await loadMedia(fetchChunk);
  if (media.revision !== revision) throw new Error("The image changed while loading");
  return `data:${media.mimeType};base64,${encodeBase64(media.parts)}`;
}
