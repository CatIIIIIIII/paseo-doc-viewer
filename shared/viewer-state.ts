import { z } from "zod";
import { PIN_LABEL_MAX_CHARS, PINS_MAX_PER_FILE } from "./limits";

const index = z.number().int().min(0).max(10_000_000);
const zoom = z.number().min(1).max(3);
// Zoom is kept per layout class: 1.5x on a wide window would crop the page on a phone.
// Page, text mode and sheet window stay shared by every client.
const zooms = z.object({ compact: zoom.optional(), wide: zoom.optional() });
export const viewerPosition = z.discriminatedUnion("type", [
  z.object({ type: z.literal("page"), index, zoom, text: z.boolean(), zooms: zooms.optional() }),
  z.object({ type: z.literal("grid"), sheet: index, rowOffset: index, columnOffset: index }),
]);
export type ViewerPosition = z.infer<typeof viewerPosition>;
type PagePosition = Extract<ViewerPosition, { type: "page" }>;
export type LayoutClass = keyof z.infer<typeof zooms>;

export const layoutClass = (compact: boolean): LayoutClass => (compact ? "compact" : "wide");

// Positions saved before zooms existed came almost always from wide windows, so a phone starts those at Fit.
const savedZooms = (position: PagePosition) => position.zooms ?? { wide: position.zoom };

export function zoomFor(position: PagePosition, layout: LayoutClass): number {
  return savedZooms(position)[layout] ?? 1;
}

// A write carries the writer's layout zoom only; the other layout's zoom is kept from the saved position.
export function mergeZooms(saved: ViewerPosition | undefined, next: ViewerPosition): ViewerPosition {
  if (next.type !== "page" || !next.zooms || saved?.type !== "page") return next;
  return { ...next, zooms: { ...savedZooms(saved), ...next.zooms } };
}

export const documentRevision = z.string().min(1).max(64);
export const pinLabel = z.string().max(PIN_LABEL_MAX_CHARS);
export const pagePin = z.object({ index, label: pinLabel.optional(), revision: documentRevision });
export type PagePin = z.infer<typeof pagePin>;
export const pagePins = z.array(pagePin).max(PINS_MAX_PER_FILE);
export const reviewMark = z.object({ revision: documentRevision, at: z.number() });
export type ReviewMark = z.infer<typeof reviewMark>;
