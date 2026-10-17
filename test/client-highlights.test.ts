import { describe, expect, it } from "vitest";
import { pageHighlights } from "../client/highlights";
import type { SearchMatch, SearchNavigation } from "../shared/search";

const box = (y: number) => ({ x: 0.1, y, width: 0.2, height: 0.02 });
const match = (page: number, start: number, boxes = [box(0.5)]): SearchMatch => ({
  target: { type: "page", index: page },
  start,
  length: 6,
  snippet: "",
  boxes,
});
const navigation = (page: number, start: number): SearchNavigation => ({
  target: { type: "page", index: page },
  query: "q",
  start,
  serial: 1,
});

describe("pageHighlights", () => {
  it("keeps only the current page's matches that carry boxes", () => {
    const matches = [match(0, 3), match(1, 10), match(1, 40)];
    const result = pageHighlights(matches, 1, null);
    expect(result).toHaveLength(2);
    expect(result.map((highlight) => highlight.selected)).toEqual([false, false]);
  });

  it("marks the navigation match as selected", () => {
    const matches = [match(1, 10), match(1, 40)];
    const result = pageHighlights(matches, 1, navigation(1, 40));
    expect(result.map((highlight) => highlight.selected)).toEqual([false, true]);
  });

  it("ignores matches without boxes and non-page targets", () => {
    const noBoxes: SearchMatch = { target: { type: "page", index: 1 }, start: 5, length: 6, snippet: "" };
    const cell: SearchMatch = { target: { type: "cell", sheet: 0, row: 1, column: 2 }, start: 0, length: 4, snippet: "", boxes: [box(0.2)] };
    expect(pageHighlights([noBoxes, cell, match(1, 9)], 1, null)).toHaveLength(1);
  });

  it("does not mark a selection from another page", () => {
    const matches = [match(1, 10)];
    expect(pageHighlights(matches, 1, navigation(2, 10))[0]!.selected).toBe(false);
  });
});
