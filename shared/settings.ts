import { defineSettings, settingsRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const viewerSettings = defineSettings({
  id: "viewer",
  scope: "host",
  version: 1,
  schema: z.object({
    // A timeline card per agent turn listing the documents that changed while it ran.
    turnCards: z.boolean().default(true),
    kindColors: z.boolean().default(true),
  }),
});

// The host serves these as ordinary plugin RPCs, so surfaces without the settings hook can read them.
export const viewerSettingsRpc = settingsRpc(viewerSettings.id);
