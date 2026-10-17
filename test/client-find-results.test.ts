import { describe, expect, it } from "vitest";
import { matchCount, matchLocation, trimSnippet } from "../client/find-results";

// Builds a match the way the server does: 45 characters before the match and 65 after.
function serverMatch(text: string, query: string) {
  const start = text.indexOf(query);
  return { start, length: query.length, snippet: text.slice(Math.max(0, start - 45), start + query.length + 65) };
}

describe("find result snippets", () => {
  it("drops the partial words the server's window cut through and marks the cuts", () => {
    const text = "In the third quarter, the quarterly report shows that early revenue grew in every region, while the cost of migration stayed flat across the year and beyond";
    const trimmed = trimSnippet(serverMatch(text, "revenue"));
    expect(trimmed.match).toBe("revenue");
    expect(trimmed.before).toBe("…the quarterly report shows that early ");
    expect(trimmed.after).toBe(" grew in every region, while the cost of migration stayed flat…");
  });

  it("keeps a snippet that starts at the beginning of the text and ends with it", () => {
    expect(trimSnippet(serverMatch("Revenue grew.", "Revenue"))).toEqual({ before: "", match: "Revenue", after: " grew." });
  });

  it("collapses line breaks and runs of spaces", () => {
    expect(trimSnippet(serverMatch("Total\n\nrevenue   by region", "revenue"))).toEqual({ before: "Total ", match: "revenue", after: " by region" });
  });
});

describe("find result labels", () => {
  it("names pages, slides, text blocks and cells", () => {
    expect(matchLocation({ type: "page", index: 2 }, "Slide")).toBe("Slide 3");
    expect(matchLocation({ type: "block", index: 4 }, "Page")).toBe("Text");
    expect(matchLocation({ type: "cell", sheet: 0, row: 1, column: 1 }, "Page")).toBe("Sheet 1, B2");
  });

  it("counts matches, then shows the selected one as n of N", () => {
    const base = { found: 8, selected: -1, more: false, busy: false, error: false };
    expect(matchCount(base)).toBe("8 matches");
    expect(matchCount({ ...base, found: 1 })).toBe("1 match");
    expect(matchCount({ ...base, selected: 2 })).toBe("3 of 8");
    expect(matchCount({ ...base, selected: 2, more: true })).toBe("3 of 8+ so far");
    expect(matchCount({ ...base, busy: true })).toBe("Searching… 8 so far");
  });
});
