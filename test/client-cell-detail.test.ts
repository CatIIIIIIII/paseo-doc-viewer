import { describe, expect, it } from "vitest";
import { cellReference, inspectorFields } from "../client/cell-detail";

const field = (fields: ReturnType<typeof inspectorFields>, label: string) => fields.find((entry) => entry.label === label);

describe("cell inspector", () => {
  it("names a cell with its sheet, quoting names Excel would quote", () => {
    expect(cellReference("Summary", 7, 1)).toBe("Summary!B8");
    expect(cellReference("Q1 data", 0, 27)).toBe("'Q1 data'!AB1");
    expect(cellReference("Bob's", 0, 0)).toBe("'Bob''s'!A1");
    expect(cellReference("A1", 0, 0)).toBe("'A1'!A1");
    expect(cellReference("2026", 0, 0)).toBe("'2026'!A1");
    expect(cellReference(null, 4, 2)).toBe("C5");
  });

  it("separates the formula, saved result, number format and type", () => {
    const fields = inspectorFields({ type: "n", raw: "165", display: "$165.00", numberFormat: '"$"#,##0.00',
      formula: { kind: "normal", text: "B7*1.1", cached: true } });
    expect(fields.map(({ label, value }) => [label, value])).toEqual([
      ["Formula", "=B7*1.1"],
      ["Saved result", "165"],
      ["Type", "Number"],
      ["Number format", '"$"#,##0.00'],
    ]);
  });

  it("reports a missing saved result as information", () => {
    const fields = inspectorFields({ type: "n", raw: null, display: "", numberFormat: "General",
      formula: { kind: "shared", text: "B10+C10", cached: false, master: "D3", masterText: "B3+C3", range: "D3:D10" } });
    expect(field(fields, "Saved result")).toEqual({ label: "Saved result", value: "None saved", tone: "info",
      note: "The file holds no calculated value for this formula, for example because it was written without recalculating. This alone does not mean the formula is wrong." });
    expect(field(fields, "Formula")?.value).toBe("=B10+C10");
    expect(field(fields, "Shared formula")?.value).toBe("From D3 (=B3+C3), range D3:D10");
    expect(field(fields, "Type")?.value).toBe("Not known without a saved result");
  });

  it("never invents a formula it cannot derive", () => {
    const unshiftable = inspectorFields({ type: "n", raw: "4", display: "4", numberFormat: "General",
      formula: { kind: "shared", text: null, cached: true, master: "B1", masterText: "SUM(A:A)", range: "B1:B9" } });
    expect(field(unshiftable, "Formula")?.value).toBe("Not shown: the shared formula from B1 cannot be adjusted to this cell exactly");
    expect(field(unshiftable, "Shared formula")?.value).toBe("From B1 (=SUM(A:A)), range B1:B9");
    const orphan = inspectorFields({ type: "n", raw: "5", display: "5", numberFormat: "General", formula: { kind: "shared", text: null, cached: true } });
    expect(field(orphan, "Formula")?.value).toBe("Not shown: the cell that holds this shared formula was not found");
    const table = inspectorFields({ type: "n", raw: "3", display: "3", numberFormat: "General", formula: { kind: "dataTable", text: null, cached: true, range: "D1:E2" } });
    expect(field(table, "Formula")?.value).toBe("Data table D1:E2: the file stores no formula for each cell");
    const array = inspectorFields({ type: "n", raw: "1", display: "1", numberFormat: "General", formula: { kind: "array", text: "ROW(A1:A2)", cached: true, range: "E1:E2" } });
    expect(field(array, "Formula")?.value).toBe("{=ROW(A1:A2)}");
    expect(field(array, "Array formula")?.value).toBe("Spans E1:E2");
    const long = inspectorFields({ type: "n", raw: "1", display: "1", numberFormat: "General", formula: { kind: "normal", text: "A1", cached: true, truncated: true } });
    expect(field(long, "Formula")?.note).toBe("Shortened to the first 8,192 characters.");
  });

  it("shows the raw value of a plain cell next to its type and format", () => {
    const date = inspectorFields({ type: "n", raw: "46032", display: "2026-01-10", numberFormat: "yyyy-mm-dd" });
    expect(date.map(({ label, value }) => [label, value])).toEqual([["Raw value", "46032"], ["Type", "Number"], ["Number format", "yyyy-mm-dd"]]);
    expect(field(inspectorFields({ type: "e", raw: "#REF!", display: "#REF!", numberFormat: "General" }), "Type")?.value).toBe("Error");
    expect(field(inspectorFields({ type: "b", raw: "1", display: "true", numberFormat: "General" }), "Type")?.value).toBe("Boolean (1 is true)");
    expect(field(inspectorFields({ type: "s", raw: "North", display: "North", numberFormat: "General" }), "Type")?.value).toBe("Text (shared string)");
  });

  it("describes CSV cells and empty cells plainly", () => {
    expect(inspectorFields({ type: "text", raw: "=SUM(A1)", display: "=SUM(A1)" }).map(({ label, value }) => [label, value])).toEqual([
      ["Raw value", "=SUM(A1)"],
      ["Type", "Text (CSV and TSV files store no types or formulas)"],
    ]);
    expect(inspectorFields(null)).toEqual([{ label: "Type", value: "Empty: nothing is stored in this cell" }]);
  });
});
