import { describe, expect, it } from "vitest";
import { coverageText, issueLabel, issueSummary, mergeInspected, pausedText } from "../client/issues";

const names = ["Summary", "Q1 data"];

describe("issue scan text", () => {
  it("merges the ranges inspected by successive calls", () => {
    const merged = mergeInspected([{ sheet: 0, fromRow: 0, toRow: 5 }], [{ sheet: 0, fromRow: 5, toRow: 10 }, { sheet: 1, fromRow: 0, toRow: 0 }]);
    expect(merged).toEqual([{ sheet: 0, fromRow: 0, toRow: 10 }, { sheet: 1, fromRow: 0, toRow: 0 }]);
    expect(mergeInspected(merged, [{ sheet: 1, fromRow: 0, toRow: 3 }])).toEqual([{ sheet: 0, fromRow: 0, toRow: 10 }, { sheet: 1, fromRow: 0, toRow: 3 }]);
  });

  it("states what was inspected and where a scan paused", () => {
    expect(coverageText([{ sheet: 0, fromRow: 0, toRow: 1200 }, { sheet: 1, fromRow: 0, toRow: 0 }], names)).toBe("Inspected Summary rows 1-1,200, Q1 data (no rows).");
    expect(coverageText([], names)).toBe("Nothing inspected yet.");
    expect(pausedText("time", { sheet: 1, row: 4999, column: 0 }, names)).toBe("Paused at the time limit, before Q1 data row 5,000.");
    expect(pausedText("rows", { sheet: 0, row: 250000, column: 0 }, names)).toBe("Paused at the row limit, before Summary row 250,001.");
    expect(pausedText("issues", { sheet: 0, row: 4, column: 2 }, names)).toBe("Paused at the issue limit, at Summary!C5.");
  });

  it("counts and labels issues without calling a missing result an error", () => {
    const error = { sheet: 0, row: 4, column: 4, kind: "error" as const, display: "#DIV/0!", formula: "C5/0" };
    const missing = { sheet: 1, row: 8, column: 3, kind: "missing-result" as const, display: "", formula: `SUM(${"A1,".repeat(40)}A2)` };
    expect(issueLabel(error, names)).toBe("Summary!E5: #DIV/0! · =C5/0");
    expect(issueLabel(missing, names)).toBe(`'Q1 data'!D9: no saved result · =SUM(${"A1,".repeat(18)}A…`);
    expect(issueLabel({ ...error, formula: null }, names)).toBe("Summary!E5: #DIV/0!");
    expect(issueSummary([error, missing, missing])).toBe("1 error cell, 2 formulas without a saved result");
    expect(issueSummary([])).toBe("No error cells or formulas without a saved result");
  });
});
