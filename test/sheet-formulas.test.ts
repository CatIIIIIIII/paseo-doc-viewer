import { describe, expect, it } from "vitest";
import { shiftFormula } from "../server/formulas";

describe("shared formulas are expanded only when every reference shifts with certainty", () => {
  it("moves relative references and keeps absolute parts fixed", () => {
    expect(shiftFormula("A2*2", 1, 0)).toBe("A3*2");
    expect(shiftFormula("SUM($A2:B$2)+$C$1", 2, 1)).toBe("SUM($A4:C$2)+$C$1");
    expect(shiftFormula("Sheet2!B3+'Q1 data'!C4", 1, 1)).toBe("Sheet2!C4+'Q1 data'!D5");
  });

  it("leaves strings, functions, numbers and names untouched", () => {
    expect(shiftFormula('IF(A1>1E5,"A1 ""B2""",LOG10(B1))&_xlfn.XLOOKUP(A1,Rates,TAX)', 1, 0)).toBe(
      'IF(A2>1E5,"A1 ""B2""",LOG10(B2))&_xlfn.XLOOKUP(A2,Rates,TAX)',
    );
    expect(shiftFormula("TRUE+#REF!+A1#", 0, 1)).toBe("TRUE+#REF!+B1#");
  });

  it("refuses whole-row, whole-column, structured and external references", () => {
    expect(shiftFormula("SUM(A:A)", 1, 0)).toBeNull();
    expect(shiftFormula("SUM(1:1)", 1, 0)).toBeNull();
    expect(shiftFormula("SUM($A:$A)", 1, 0)).toBeNull();
    expect(shiftFormula("SUM(Table1[Amount])", 1, 0)).toBeNull();
    expect(shiftFormula("[1]Sheet1!A1", 1, 0)).toBeNull();
  });

  it("refuses a shift that leaves the grid and malformed text", () => {
    expect(shiftFormula("A1", -1, 0)).toBeNull();
    expect(shiftFormula("XFD1", 0, 1)).toBeNull();
    expect(shiftFormula('"open', 1, 0)).toBeNull();
    expect(shiftFormula("'Sheet", 1, 0)).toBeNull();
  });
});
