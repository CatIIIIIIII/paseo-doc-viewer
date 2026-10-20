import type { PluginTheme } from "@getpaseo/plugin";
import { useEffect, useMemo, useRef, useState } from "react";
import { viewerSettings } from "../shared/settings";
import { kindPalette, type KindPalette } from "./kind-colors";

type ReadSettings = () => Promise<{ status: string; values?: unknown }>;

const REREAD_MS = 30_000;

// Turn cards have no settings hook, so the value is read over the host's settings RPC and kept here;
// the settings screen updates it on save. An answer that is not a valid value keeps the last one known.
let enabled = viewerSettings.schema.parse({}).kindColors;
let readAt = 0;
let reading: Promise<void> | null = null;
let saved = 0;
const listeners = new Set<(value: boolean) => void>();

function publish(value: boolean) {
  enabled = value;
  for (const listener of listeners) listener(value);
}

export const kindColorsSetting = {
  get: () => enabled,
  subscribe(listener: (value: boolean) => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  set(value: boolean) {
    saved++;
    readAt = Date.now();
    publish(value);
  },
  refresh(read: ReadSettings) {
    if (reading || Date.now() - readAt < REREAD_MS) return;
    const savedBefore = saved;
    reading = read().then(
      (answer) => {
        // A read that started before a save answers with the value from before it.
        if (saved !== savedBefore) return;
        const values = answer.status === "ready" ? viewerSettings.schema.safeParse(answer.values) : null;
        if (values?.success) publish(values.data.kindColors);
      },
      () => {},
    ).finally(() => {
      readAt = Date.now();
      reading = null;
    });
  },
};

// `polledAt` is when an open panel last polled its data: the setting is read again with it, at most every
// REREAD_MS, so a change made on another client shows up. The host gives panels no focus or visibility
// event, and a list poll already stops while the window is hidden and runs again on focus.
export function useKindPalette(theme: PluginTheme, read: ReadSettings, polledAt?: number): KindPalette {
  const [on, setOn] = useState(enabled);
  const reader = useRef(read);
  reader.current = read;
  useEffect(() => {
    const unsubscribe = kindColorsSetting.subscribe(setOn);
    setOn(enabled);
    return unsubscribe;
  }, []);
  useEffect(() => {
    kindColorsSetting.refresh(reader.current);
  }, [polledAt]);
  return useMemo(() => kindPalette(theme.colors, on), [theme.colors, on]);
}
