import { createElement, type ReactElement } from "react";
import { Platform } from "react-native";

// This plugin typechecks without the DOM library. Declare only what this module uses.
declare const Blob: new (parts: readonly Uint8Array[], options: { type: string }) => object;
declare const URL: { createObjectURL(blob: object): string; revokeObjectURL(url: string): void };

export const canPlayVideo = Platform.OS === "web";

export function createMediaUrl(parts: readonly Uint8Array[], mimeType: string): string | null {
  if (Platform.OS !== "web") return null;
  return URL.createObjectURL(new Blob(parts, { type: mimeType }));
}

export function revokeMediaUrl(url: string): void {
  if (Platform.OS !== "web") return;
  URL.revokeObjectURL(url);
}

export interface VideoElementProps {
  uri: string;
  label: string;
  background: string;
}

export function VideoElement({ uri, label, background }: VideoElementProps): ReactElement | null {
  if (Platform.OS !== "web") return null;
  return createElement("video", {
    src: uri,
    controls: true,
    playsInline: true,
    "aria-label": label,
    style: { width: "100%", height: "100%", objectFit: "contain", backgroundColor: background, display: "block" },
  });
}
