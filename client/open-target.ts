import type { PluginOpenScreenInput } from "@getpaseo/plugin/client";
import { useEffect, useState } from "react";
import { viewerSettings } from "../shared/settings";

// Openers that render (turn cards) pass their layout; commands and /doc have none and guess from the window.
export type DocumentOpener = (input: PluginOpenScreenInput, layout?: { compact: boolean }) => void;
export const COMPACT_WINDOW_MAX = 768;

export type OpenPreference = "auto" | "side" | "full";
export const OPEN_OPTIONS: readonly { label: string; value: OpenPreference }[] = [
  { label: "Auto", value: "auto" },
  { label: "Side by side", value: "side" },
  { label: "Full view", value: "full" },
];
// in-place: a Documents panel is on screen, so it shows the document without any navigation.
// explorer: Documents opens in the side column next to the chat. screen: the standalone document screen.
export type OpenTarget = "in-place" | "explorer" | "screen";

// Below this window width Paseo narrows the explorer under its 320 pt default and leaves the chat
// under about 460 pt (measured on Paseo 0.12 web with the sidebar open), so auto picks the full view.
export const SIDE_BY_SIDE_MIN_WINDOW = 1100;

export interface OpenContext {
  compact: boolean;
  panelVisible: boolean;
  preference: OpenPreference | undefined;
  windowWidth: number;
}

const WIDE: { readonly [P in OpenPreference]: (windowWidth: number) => OpenTarget } = {
  auto: (windowWidth) => (windowWidth >= SIDE_BY_SIDE_MIN_WINDOW ? "explorer" : "screen"),
  side: () => "explorer",
  full: () => "screen",
};

// Phones always take the full screen, with its URL and back gesture; inside Documents the panel opens
// files itself. On a wide layout a visible Documents panel wins over the preference.
export function openTarget({ compact, panelVisible, preference, windowWidth }: OpenContext): OpenTarget {
  if (compact) return "screen";
  if (panelVisible) return "in-place";
  return WIDE[preference ?? "auto"](windowWidth);
}

type ReadSettings = () => Promise<{ status: string; values?: unknown }>;

// undefined until the first read; "unset" while the chooser has not been answered.
let preference: OpenPreference | "unset" | undefined;
const listeners = new Set<(value: OpenPreference | "unset") => void>();

function parse(answer: { status: string; values?: unknown }): OpenPreference | "unset" {
  const values = answer.status === "ready" ? viewerSettings.schema.safeParse(answer.values) : null;
  return values?.success ? values.data.openDocuments ?? "unset" : "unset";
}

export const openPreference = {
  current: () => preference,
  set(value: OpenPreference) {
    preference = value;
    for (const listener of listeners) listener(value);
  },
  async read(read: ReadSettings): Promise<OpenPreference | "unset"> {
    try {
      const value = parse(await read());
      preference = value;
      for (const listener of listeners) listener(value);
      return value;
    } catch {
      return preference ?? "unset";
    }
  },
};

export function useOpenPreference(read: ReadSettings): OpenPreference | "unset" | undefined {
  const [value, setValue] = useState(preference);
  useEffect(() => {
    listeners.add(setValue);
    if (preference === undefined) void openPreference.read(read);
    return () => {
      listeners.delete(setValue);
    };
  }, []);
  return value;
}
