import type { CellDetail } from "../shared/rpc";
import { columnName } from "./paging";

export interface InspectorField {
  label: string;
  value: string;
  tone?: "info";
  note?: string;
}

const PLAIN_SHEET_NAME = /^[A-Za-z_][A-Za-z0-9_.]*$/;
const LOOKS_LIKE_CELL = /^[A-Za-z]{1,3}\d+$/;

export function cellReference(sheetName: string | null, row: number, column: number): string {
  const cell = `${columnName(column)}${row + 1}`;
  if (sheetName === null) return cell;
  const sheet = PLAIN_SHEET_NAME.test(sheetName) && !LOOKS_LIKE_CELL.test(sheetName) ? sheetName : `'${sheetName.replace(/'/g, "''")}'`;
  return `${sheet}!${cell}`;
}

const TYPE_LABELS: { readonly [K in CellDetail["type"]]: string } = {
  n: "Number",
  s: "Text (shared string)",
  str: "Text (formula result)",
  inlineStr: "Text (inline)",
  b: "Boolean (1 is true)",
  e: "Error",
  d: "Date (ISO 8601)",
  text: "Text (CSV and TSV files store no types or formulas)",
};

const MISSING_RESULT_NOTE =
  "The file holds no calculated value for this formula, for example because it was written without recalculating. This alone does not mean the formula is wrong.";

function formulaFields(formula: NonNullable<CellDetail["formula"]>): InspectorField[] {
  const truncated = formula.truncated ? { note: "Shortened to the first 8,192 characters." } : {};
  if (formula.kind === "dataTable") {
    return [{ label: "Formula", value: `Data table${formula.range ? ` ${formula.range}` : ""}: the file stores no formula for each cell` }];
  }
  if (formula.kind === "array") {
    return [
      { label: "Formula", value: formula.text === null ? "Not stored" : `{=${formula.text}}`, ...truncated },
      ...(formula.range ? [{ label: "Array formula", value: `Spans ${formula.range}` }] : []),
    ];
  }
  if (formula.kind === "shared") {
    const value = formula.text !== null ? `=${formula.text}`
      : formula.master ? `Not shown: the shared formula from ${formula.master} cannot be adjusted to this cell exactly`
      : "Not shown: the cell that holds this shared formula was not found";
    const source = formula.master
      ? [{ label: "Shared formula", value: `From ${formula.master}${formula.masterText ? ` (=${formula.masterText})` : ""}${formula.range ? `, range ${formula.range}` : ""}` }]
      : [];
    return [{ label: "Formula", value, ...truncated }, ...source];
  }
  return [{ label: "Formula", value: `=${formula.text ?? ""}`, ...truncated }];
}

// Rows for the inspector: what the file stores, kept apart from how the grid displays it.
export function inspectorFields(detail: CellDetail | null): InspectorField[] {
  if (!detail) return [{ label: "Type", value: "Empty: nothing is stored in this cell" }];
  const fields: InspectorField[] = [];
  if (detail.formula) {
    fields.push(...formulaFields(detail.formula));
    fields.push(detail.raw === null
      ? { label: "Saved result", value: "None saved", tone: "info", note: MISSING_RESULT_NOTE }
      : { label: "Saved result", value: detail.raw });
  } else {
    fields.push({ label: "Raw value", value: detail.raw ?? "" });
  }
  fields.push({ label: "Type", value: detail.raw === null ? "Not known without a saved result" : TYPE_LABELS[detail.type] });
  if (detail.numberFormat !== undefined) fields.push({ label: "Number format", value: detail.numberFormat });
  return fields;
}
