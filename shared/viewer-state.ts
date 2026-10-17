import { z } from "zod";

const index = z.number().int().min(0).max(10_000_000);
export const viewerPosition = z.discriminatedUnion("type", [
  z.object({ type: z.literal("page"), index, zoom: z.number().min(1).max(3), text: z.boolean() }),
  z.object({ type: z.literal("grid"), sheet: index, rowOffset: index, columnOffset: index }),
]);
export type ViewerPosition = z.infer<typeof viewerPosition>;
