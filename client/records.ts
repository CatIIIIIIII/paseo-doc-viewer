import type { CellDetail } from "../shared/rpc";
import { formatCount } from "./format";
import { columnName } from "./paging";

export interface RecordField {
  column: number;
  label: string;
  value: string;
  note?: string;
}

// Cells that store nothing are left off the card; a wide, sparse row would otherwise be mostly blank labels.
export function recordFields(
  header: readonly string[] | null,
  values: readonly string[],
  columnOffset: number,
  details?: readonly (CellDetail | null)[],
): { fields: RecordField[]; hiddenEmpty: number } {
  const fields: RecordField[] = [];
  let hiddenEmpty = 0;
  values.forEach((value, index) => {
    const detail = details?.[index];
    if (!value && !detail) {
      hiddenEmpty++;
      return;
    }
    const column = columnOffset + index;
    const missing = !value && detail?.formula && detail.raw === null;
    fields.push({ column, label: header?.[index]?.trim() || columnName(column), value, ...(missing ? { note: "Formula without a saved result" } : {}) });
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

// The header row chosen for a sheet, kept in app memory for the session (never stored on disk).
// Like the review drafts it hangs off the global object, so a bundle re-evaluated on reconnect keeps it.
const HEADERS_KEY = Symbol.for("paseo-doc-viewer/record-headers/v1");
const MAX_REMEMBERED_HEADERS = 500;

export function createHeaderMemory() {
  const headers = new Map<string, number | null>();
  const key = (workspaceId: string, path: string, sheet: number) => `${workspaceId}\0${path}\0${sheet}`;
  return {
    get: (workspaceId: string, path: string, sheet: number): number | null | undefined => headers.get(key(workspaceId, path, sheet)),
    set(workspaceId: string, path: string, sheet: number, header: number | null) {
      const id = key(workspaceId, path, sheet);
      headers.delete(id);
      headers.set(id, header);
      if (headers.size > MAX_REMEMBERED_HEADERS) headers.delete(headers.keys().next().value!);
    },
  };
}

export type HeaderMemory = ReturnType<typeof createHeaderMemory>;

export function sharedHeaderMemory(global: object): HeaderMemory {
  const holder = global as { [HEADERS_KEY]?: HeaderMemory };
  return (holder[HEADERS_KEY] ??= createHeaderMemory());
}

export const recordHeaders = sharedHeaderMemory(globalThis);
