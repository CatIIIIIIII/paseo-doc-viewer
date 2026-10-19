import { describe, expect, it } from "vitest";
import { documentScreen } from "../client/recent";
import { DOCUMENT_SIBLINGS_MAX, parseSiblings, siblingPosition } from "../client/siblings";

const card = ["out/report.pdf", "out/chart.png", "data/metrics.xlsx"];

describe("document siblings", () => {
  it("travel in the screen params only when a turn card opens the file", () => {
    expect(documentScreen("w", "out/report.pdf")).toEqual({ screenId: "document", params: { workspaceId: "w", path: "out/report.pdf" } });
    const opened = documentScreen("w", "out/chart.png", card);
    expect(parseSiblings(opened.params!.siblings)).toEqual(card);
    expect(documentScreen("w", "out/report.pdf", ["out/report.pdf"]).params).not.toHaveProperty("siblings");
  });

  it("parse to nothing unless the param is a short list of distinct paths", () => {
    expect(parseSiblings(undefined)).toBeNull();
    for (const param of ["", "{", "null", '"a.pdf"', '{"0":"a.pdf"}', '["a.pdf"]', '["a.pdf", 3]', '["a.pdf", ""]', '["a.pdf", "a.pdf"]',
      JSON.stringify(Array.from({ length: DOCUMENT_SIBLINGS_MAX + 1 }, (_, i) => `f${i}.pdf`))]) {
      expect(parseSiblings(param), param.slice(0, 40)).toBeNull();
    }
    expect(parseSiblings(JSON.stringify(Array.from({ length: DOCUMENT_SIBLINGS_MAX }, (_, i) => `f${i}.pdf`)))).toHaveLength(DOCUMENT_SIBLINGS_MAX);
  });

  it("step through the card in order and stop at both ends", () => {
    expect(siblingPosition(card, "out/report.pdf")).toEqual({ index: 0, count: 3, previous: null, next: "out/chart.png" });
    expect(siblingPosition(card, "out/chart.png")).toEqual({ index: 1, count: 3, previous: "out/report.pdf", next: "data/metrics.xlsx" });
    expect(siblingPosition(card, "data/metrics.xlsx")).toEqual({ index: 2, count: 3, previous: "out/chart.png", next: null });
    expect(siblingPosition(card, "elsewhere.pdf")).toBeNull();
    expect(siblingPosition(null, "out/report.pdf")).toBeNull();
  });
});
