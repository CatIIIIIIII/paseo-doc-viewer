import { z } from "zod";
import { PIN_LABEL_MAX_CHARS, PINS_MAX_PER_FILE } from "./limits";

const index = z.number().int().min(0).max(10_000_000);
export const viewerPosition = z.discriminatedUnion("type", [
  z.object({ type: z.literal("page"), index, zoom: z.number().min(1).max(3), text: z.boolean() }),
  z.object({ type: z.literal("grid"), sheet: index, rowOffset: index, columnOffset: index }),
]);
export type ViewerPosition = z.infer<typeof viewerPosition>;

export const documentRevision = z.string().min(1).max(64);
export const pinLabel = z.string().max(PIN_LABEL_MAX_CHARS);
export const pagePin = z.object({ index, label: pinLabel.optional(), revision: documentRevision });
export type PagePin = z.infer<typeof pagePin>;
export const pagePins = z.array(pagePin).max(PINS_MAX_PER_FILE);
export const reviewMark = z.object({ revision: documentRevision, at: z.number() });
export type ReviewMark = z.infer<typeof reviewMark>;
