import { createElement, type ReactNode, type ReactElement } from "react";
import { Platform, View } from "react-native";

// This plugin typechecks without the DOM library. Declare only what this module uses.
declare const Blob: new (parts: readonly Uint8Array[], options: { type: string }) => object;
declare const URL: { createObjectURL(blob: object): string; revokeObjectURL(url: string): void };

export const canPlayMedia = Platform.OS === "web";

export function createMediaUrl(parts: readonly Uint8Array[], mimeType: string): string | null {
  if (Platform.OS !== "web") return null;
  return URL.createObjectURL(new Blob(parts, { type: mimeType }));
}

export function revokeMediaUrl(url: string): void {
  if (Platform.OS !== "web") return;
  URL.revokeObjectURL(url);
}

export interface MediaElementProps {
  uri: string;
  label: string;
  background: string;
  kind?: "video" | "audio";
  onError?: () => void;
}

export function MediaElement({ uri, label, background, kind = "video", onError }: MediaElementProps): ReactElement | null {
  if (Platform.OS !== "web") return null;
  return createElement(kind, {
    src: uri,
    controls: true,
    onError,
    preload: "metadata",
    playsInline: true,
    "aria-label": label,
    style: { width: "100%", height: kind === "audio" ? 54 : "100%", objectFit: "contain", backgroundColor: background, display: "block" },
  });
}

export const canDownloadOriginal = Platform.OS === "web" && typeof Blob !== "undefined" && typeof URL !== "undefined" && typeof URL.createObjectURL === "function";
export function DownloadLink({ uri, name, color }: { uri: string; name: string; color: string }): ReactElement | null {
  if (!canDownloadOriginal) return null;
  return createElement("a", { href: uri, download: name, style: { color, padding: 6, fontSize: 13 }, "aria-label": "Save original file" }, "Save original");
}

interface ScopeElement {
  parentElement: ScopeElement | null;
  scrollHeight: number; clientHeight: number; scrollWidth: number; clientWidth: number;
  tabIndex: number;
  hasAttribute(name: string): boolean;
  closest(selector: string): unknown;
  focus(options: { preventScroll: boolean }): void;
}
declare const getComputedStyle: (element: ScopeElement) => { overflowX: string; overflowY: string };

const scrolls = (element: ScopeElement) => {
  const style = getComputedStyle(element);
  return (/auto|scroll/.test(style.overflowY) && element.scrollHeight > element.clientHeight)
    || (/auto|scroll/.test(style.overflowX) && element.scrollWidth > element.clientWidth);
};

// Keyboard handling is scoped to this viewer, so other tabs retain their shortcuts.
// A click focuses the scroll area under the pointer, not the wrapper, so the
// keyboard keeps scrolling the content and the wrapper adds no tab stop.
export function FindScope({ children, onFind, enabled = true }: { children: ReactNode; onFind(): void; enabled?: boolean }): ReactElement {
  if (Platform.OS !== "web") return createElement(View, { style: { flex: 1 } }, children);
  return createElement("div", {
    style: { display: "flex", flexDirection: "column", flex: 1, minHeight: 0 },
    onKeyDown: (event: { key: string; ctrlKey: boolean; metaKey: boolean; preventDefault(): void; stopPropagation(): void }) => {
      if (enabled && event.key.toLowerCase() === "f" && (event.ctrlKey || event.metaKey)) { event.preventDefault(); event.stopPropagation(); onFind(); }
    },
    onMouseDown: (event: { target: ScopeElement; currentTarget: ScopeElement }) => {
      if (event.target.closest("input,textarea,button,a,audio,video,[role=button],[tabindex]")) return;
      let element: ScopeElement | null = event.target;
      while (element && element !== event.currentTarget && !scrolls(element)) element = element.parentElement;
      if (!element || element === event.currentTarget) return;
      if (!element.hasAttribute("tabindex")) element.tabIndex = -1;
      element.focus({ preventScroll: true });
    },
  }, children);
}
