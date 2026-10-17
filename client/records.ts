import { formatCount } from "./format";
import { columnName } from "./paging";

export interface RecordField {
  column: number;
  label: string;
  value: string;
}

// Empty cells are left off the card; a wide, sparse row would otherwise be mostly blank labels.
export function recordFields(header: readonly string[] | null, values: readonly string[], columnOffset: number): { fields: RecordField[]; hiddenEmpty: number } {
  const fields: RecordField[] = [];
  let hiddenEmpty = 0;
  values.forEach((value, index) => {
    if (!value) {
      hiddenEmpty++;
      return;
    }
    const column = columnOffset + index;
    fields.push({ column, label: header?.[index]?.trim() || columnName(column), value });
  });
  return { fields, hiddenEmpty };
}

export const firstRecord = (header: number | null) => (header === null ? 0 : header + 1);

export function clampRecord(row: number, header: number | null, rowCount: number): number {
  return Math.max(firstRecord(header), Math.min(row, rowCount - 1));
}

export function recordLabel(row: number, header: number | null, rowCount: number, approximate: boolean): string {
  const first = firstRecord(header);
  return `Record ${formatCount(row - first + 1)} of ${approximate ? "about " : ""}${formatCount(Math.max(0, rowCount - first))} (row ${formatCount(row + 1)})`;
}

const PREVIEW_CELLS = 6;
const PREVIEW_CHARS = 48;

export function headerPreview(values: readonly string[]): string {
  const filled = values.map((value) => value.trim()).filter(Boolean);
  if (filled.length === 0) return "(empty row)";
  const text = filled.slice(0, PREVIEW_CELLS).join(" · ") + (filled.length > PREVIEW_CELLS ? " · …" : "");
  return text.length > PREVIEW_CHARS ? `${text.slice(0, PREVIEW_CHARS - 1)}…` : text;
}
