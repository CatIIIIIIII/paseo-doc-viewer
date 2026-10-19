import { z } from "zod";

export const DOCUMENT_SIBLINGS_MAX = 50;
const siblingsParam = z.array(z.string().min(1)).min(2).max(DOCUMENT_SIBLINGS_MAX)
  .refine((paths) => new Set(paths).size === paths.length);

export function encodeSiblings(paths: readonly string[]): string | null {
  return siblingsParam.safeParse(paths).success ? JSON.stringify(paths) : null;
}

export function parseSiblings(param: string | undefined): readonly string[] | null {
  if (param === undefined) return null;
  try {
    const parsed = siblingsParam.safeParse(JSON.parse(param));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export interface SiblingPosition {
  index: number;
  count: number;
  previous: string | null;
  next: string | null;
}

export function siblingPosition(siblings: readonly string[] | null, path: string): SiblingPosition | null {
  const index = siblings ? siblings.indexOf(path) : -1;
  if (!siblings || index < 0) return null;
  return { index, count: siblings.length, previous: siblings[index - 1] ?? null, next: siblings[index + 1] ?? null };
}
