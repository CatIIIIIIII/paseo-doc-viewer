import { z } from "zod";
const index = z.number().int().min(0).max(10_000_000);
export const searchTarget = z.discriminatedUnion("type", [
  z.object({ type: z.literal("page"), index }),
  z.object({ type: z.literal("block"), index }),
  z.object({ type: z.literal("cell"), sheet: index, row: index, column: index }),
]);
export const searchCursor = z.object({
  revision: z.string().max(256), query: z.string().min(1).max(200),
  sheet: index, unit: index, column: index, offset: index,
});
// Normalized page coordinates, origin top-left, each in [0, 1]; the client scales them to the rendered page.
export const searchBox = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
});
export const searchMatch = z.object({ target: searchTarget, snippet: z.string(), start: index, length: index, boxes: z.array(searchBox).optional() });
export type SearchTarget = z.infer<typeof searchTarget>;
export type SearchCursor = z.infer<typeof searchCursor>;
export type SearchBox = z.infer<typeof searchBox>;
export type SearchMatch = z.infer<typeof searchMatch>;
export type SearchNavigation = { target: SearchTarget; query: string; start: number; serial: number; boxes?: SearchBox[] };

export function literalPattern(query: string): RegExp {
  return new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "giu");
}
