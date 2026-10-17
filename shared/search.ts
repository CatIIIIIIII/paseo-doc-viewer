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
export const searchMatch = z.object({ target: searchTarget, snippet: z.string(), start: index, length: index });
export type SearchTarget = z.infer<typeof searchTarget>;
export type SearchCursor = z.infer<typeof searchCursor>;
export type SearchMatch = z.infer<typeof searchMatch>;
export type SearchNavigation = { target: SearchTarget; query: string; start: number; serial: number };

export function literalPattern(query: string): RegExp {
  return new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "giu");
}
