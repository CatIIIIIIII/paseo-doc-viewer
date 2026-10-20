import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import type { PluginOpenScreenInput } from "@getpaseo/plugin/client";
import { useEffect, useState } from "react";
import { viewerSettings, viewerSettingsRpc } from "../shared/settings";

export type OpenPreference = "auto" | "side" | "full";
// The Open documents setting as the daemon holds it: "unset" until the first-open chooser is answered.
export type OpenChoice = OpenPreference | "unset";
export const OPEN_OPTIONS: readonly { label: string; value: OpenPreference }[] = [
  { label: "Auto", value: "auto" },
  { label: "Side by side", value: "side" },
  { label: "Full view", value: "full" },
];
// in-place: a Documents panel on screen shows the document, with no navigation.
// explorer: Documents opens in the explorer next to the chat. screen: the document screen.
export type OpenTarget = "in-place" | "explorer" | "screen";

// Paseo's phone layout is below this window width.
export const COMPACT_WINDOW_MAX = 768;
// Below this window width Paseo narrows the explorer under its 320 pt default and leaves the chat
// under about 460 pt (measured on Paseo 0.12 web with the sidebar open), so Auto picks the full view.
export const SIDE_BY_SIDE_MIN_WINDOW = 1100;

export interface OpenContext {
  compact: boolean;
  panelVisible: boolean;
  // undefined until the setting is read.
  choice: OpenChoice | undefined;
  windowWidth: number;
}

const WIDE: { readonly [P in OpenPreference]: (windowWidth: number) => OpenTarget } = {
  auto: (windowWidth) => (windowWidth >= SIDE_BY_SIDE_MIN_WINDOW ? "explorer" : "screen"),
  side: () => "explorer",
  full: () => "screen",
};

// Phones always take the document screen, with its URL and back gesture. On a wide layout a Documents
// panel on screen wins over the setting, and a setting not yet answered or read works as Auto.
export function openTarget({ compact, panelVisible, choice, windowWidth }: OpenContext): OpenTarget {
  if (compact) return "screen";
  if (panelVisible) return "in-place";
  return WIDE[choice === undefined || choice === "unset" ? "auto" : choice](windowWidth);
}

type ReadSettings = () => Promise<RpcOutput<typeof viewerSettingsRpc.read>>;
type WriteSettings = (input: RpcInput<typeof viewerSettingsRpc.write>) => Promise<RpcOutput<typeof viewerSettingsRpc.write>>;

// Kept per client, like Color file types: screens and openers have no settings hook. The settings screen
// and the chooser update it on save.
let choice: OpenChoice | undefined;
let saves = 0;
const listeners = new Set<(value: OpenChoice) => void>();

function publish(value: OpenChoice) {
  choice = value;
  for (const listener of listeners) listener(value);
}

export const openPreference = {
  current: () => choice,
  set(value: OpenPreference) {
    saves++;
    publish(value);
  },
  // A failed or invalid read keeps what is known. A read that started before a save answers with the
  // value from before it, and must not ask again.
  async read(read: ReadSettings): Promise<OpenChoice | undefined> {
    const savesBefore = saves;
    try {
      const answer = await read();
      const values = answer.status === "ready" ? viewerSettings.schema.safeParse(answer.values) : null;
      if (values?.success && saves === savesBefore) publish(values.data.openDocuments ?? "unset");
    } catch {}
    return choice;
  },
  // Writes on top of the values read, so a conflict means another client saved in between: read again once.
  async save(read: ReadSettings, write: WriteSettings, value: OpenPreference): Promise<boolean> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const answer = await read();
      const values = answer.status === "ready" ? viewerSettings.schema.safeParse(answer.values) : null;
      if (!values?.success) return false;
      const result = await write({ revision: answer.revision, values: { ...values.data, openDocuments: value } });
      if (result.status === "saved") {
        openPreference.set(value);
        return true;
      }
      if (result.status !== "conflict") return false;
    }
    return false;
  },
};

export function useOpenChoice(read: ReadSettings): OpenChoice | undefined {
  const [value, setValue] = useState(choice);
  useEffect(() => {
    listeners.add(setValue);
    setValue(choice);
    if (choice === undefined) void openPreference.read(read);
    return () => {
      listeners.delete(setValue);
    };
  }, []);
  return value;
}

// Openers that render (turn cards) pass their layout; commands and /doc have none and go by the window.
export type DocumentOpener = (input: PluginOpenScreenInput, layout?: { compact: boolean }) => void;
