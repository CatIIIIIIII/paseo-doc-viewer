import type { SearchMatch } from "../shared/search";
import { columnName } from "./paging";

// Mirrors the server's snippet window: up to 45 characters before the match and 65 after.
const BEFORE = 45;
const AFTER = 65;

export interface TrimmedSnippet {
  before: string;
  match: string;
  after: string;
}

// Collapses whitespace and drops the partial words the server's character window cut through,
// marking each cut with an ellipsis.
export function trimSnippet({ snippet, start, length }: Pick<SearchMatch, "snippet" | "start" | "length">): TrimmedSnippet {
  const lead = Math.min(start, BEFORE);
  let before = snippet.slice(0, lead);
  const match = snippet.slice(lead, lead + length);
  let after = snippet.slice(lead + length);
  if (start > BEFORE) {
    const space = before.search(/\s/);
    before = `…${space >= 0 ? before.slice(space + 1) : ""}`;
  }
  if (after.length >= AFTER) {
    const space = after.search(/\s\S*$/);
    after = `${space >= 0 ? after.slice(0, space) : ""}…`;
  }
  const tidy = (text: string) => text.replace(/\s+/g, " ");
  return { before: tidy(before).trimStart(), match: tidy(match), after: tidy(after).trimEnd() };
}

export function matchLocation(target: SearchMatch["target"], pageLabel: string): string {
  if (target.type === "page") return `${pageLabel} ${target.index + 1}`;
  if (target.type === "block") return "Text";
  return `Sheet ${target.sheet + 1}, ${columnName(target.column)}${target.row + 1}`;
}

export function matchCount({ found, selected, more, busy, error }: { found: number; selected: number; more: boolean; busy: boolean; error: boolean }): string {
  if (busy) return `Searching… ${found} so far`;
  const total = `${found}${more ? "+" : ""}`;
  const partial = more || error ? " so far" : "";
  if (selected >= 0 && selected < found) return `${selected + 1} of ${total}${partial}`;
  return `${total} ${found === 1 && !more ? "match" : "matches"}${partial}`;
}
