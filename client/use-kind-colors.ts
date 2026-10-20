import type { PluginTheme } from "@getpaseo/plugin";
import { useEffect, useMemo, useState } from "react";
import { viewerSettings } from "../shared/settings";
import { kindPalette, type KindPalette } from "./kind-colors";

type ReadSettings = () => Promise<{ status: string; values?: unknown }>;

const REREAD_MS = 30_000;

// Turn cards have no settings hook, so the value is read over the host's settings RPC and kept here;
// the settings screen updates it on save.
let enabled = viewerSettings.schema.parse({}).kindColors;
let readAt = 0;
let reading: Promise<void> | null = null;
const listeners = new Set<(value: boolean) => void>();

function publish(value: boolean) {
  enabled = value;
  for (const listener of listeners) listener(value);
}

export const kindColorsSetting = {
  set(value: boolean) {
    readAt = Date.now();
    publish(value);
  },
  refresh(read: ReadSettings) {
    if (reading || Date.now() - readAt < REREAD_MS) return;
    reading = read().then(
      (answer) => {
        readAt = Date.now();
        const values = answer.status === "ready" ? viewerSettings.schema.safeParse(answer.values) : null;
        publish(values?.success ? values.data.kindColors : true);
      },
      () => {},
    ).finally(() => {
      reading = null;
    });
  },
};

export function useKindPalette(theme: PluginTheme, read: ReadSettings): KindPalette {
  const [on, setOn] = useState(enabled);
  useEffect(() => {
    listeners.add(setOn);
    setOn(enabled);
    kindColorsSetting.refresh(read);
    return () => {
      listeners.delete(setOn);
    };
  }, []);
  return useMemo(() => kindPalette(theme.colors, on), [theme.colors, on]);
}
