import { describe, expect, it } from "vitest";
import { clampRecord, createHeaderMemory, firstRecord, headerPreview, recordFields, recordLabel, sharedHeaderMemory } from "../client/records";

describe("record cards", () => {
  it("labels each field with the chosen header cell, falling back to the column letter", () => {
    const { fields, hiddenEmpty } = recordFields(["Region", "", "Q2", "Total"], ["North", "100", "", "220"], 0);
    expect(fields).toEqual([
      { column: 0, label: "Region", value: "North" },
      { column: 1, label: "B", value: "100" },
      { column: 3, label: "Total", value: "220" },
    ]);
    expect(hiddenEmpty).toBe(1);
  });

  it("keeps a stored cell that displays nothing, such as a formula without a saved result", () => {
    const formula = { type: "n" as const, raw: null, display: "", numberFormat: "General", formula: { kind: "normal" as const, text: "B9+C9", cached: false } };
    const { fields, hiddenEmpty } = recordFields(["Region", "Total", "Note"], ["Online", "", ""], 0, [null, formula, null]);
    expect(fields).toEqual([{ column: 0, label: "Region", value: "Online" }, { column: 1, label: "Total", value: "", note: "Formula without a saved result" }]);
    expect(hiddenEmpty).toBe(1);
  });

  it("uses column letters when the sheet has no header row and offsets them with the field window", () => {
    expect(recordFields(null, ["x", "y"], 50).fields).toEqual([
      { column: 50, label: "AY", value: "x" },
      { column: 51, label: "AZ", value: "y" },
    ]);
  });

  it("counts records after the header and keeps navigation inside them", () => {
    expect(firstRecord(1)).toBe(2);
    expect(firstRecord(null)).toBe(0);
    expect(clampRecord(0, 1, 10)).toBe(2);
    expect(clampRecord(42, 1, 10)).toBe(9);
    expect(clampRecord(5, null, 10)).toBe(5);
    expect(recordLabel(4, 1, 10, false)).toBe("Record 3 of 8 (row 5)");
    expect(recordLabel(0, null, 3, true)).toBe("Record 1 of about 3 (row 1)");
  });

  it("previews a candidate header row by its first non-empty cells", () => {
    expect(headerPreview(["Forecast 2026", "", "", ""])).toBe("Forecast 2026");
    expect(headerPreview(["Region", "Q1", "", "Q2", "Total", "Growth", "Updated", "Owner"])).toBe("Region · Q1 · Q2 · Total · Growth · Updated · …");
    expect(headerPreview(["", ""])).toBe("(empty row)");
    expect(headerPreview(["x".repeat(80)])).toBe(`${"x".repeat(47)}…`);
  });
});

describe("record header memory", () => {
  it("remembers the header row per workspace, file and sheet, including no header", () => {
    const memory = createHeaderMemory();
    memory.set("w", "a.xlsx", 0, 1);
    memory.set("w", "a.xlsx", 1, null);
    expect(memory.get("w", "a.xlsx", 0)).toBe(1);
    expect(memory.get("w", "a.xlsx", 1)).toBeNull();
    expect(memory.get("w", "a.xlsx", 2)).toBeUndefined();
    expect(memory.get("other", "a.xlsx", 0)).toBeUndefined();
    expect(memory.get("w", "b.xlsx", 0)).toBeUndefined();
  });

  it("forgets the least recently chosen sheets past 500", () => {
    const memory = createHeaderMemory();
    for (let sheet = 0; sheet <= 500; sheet++) memory.set("w", "a.xlsx", sheet, 0);
    expect(memory.get("w", "a.xlsx", 0)).toBeUndefined();
    expect(memory.get("w", "a.xlsx", 500)).toBe(0);
  });

  it("survives the bundle being evaluated again", () => {
    const global = {};
    sharedHeaderMemory(global).set("w", "a.xlsx", 0, 3);
    expect(sharedHeaderMemory(global).get("w", "a.xlsx", 0)).toBe(3);
  });
});
