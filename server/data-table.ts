import { CELL_FULL_MAX_CHARS, DATA_MAX_COLUMNS, DATA_MAX_DEPTH, XLSX_MAX_CELL_CHARS } from "../shared/limits";
import type { CellDetail } from "../shared/rpc";

// Records (JSON Lines lines, Parquet rows) shown as a grid: nested objects become key-path columns
// such as `meta.model`, up to DATA_MAX_DEPTH keys deep; deeper objects and arrays stay one cell.

export type KeyPath = readonly string[];

// The column of a line that is not a JSON object, such as a bare number or array.
export const VALUE_COLUMN_NAME = "(value)";

export const columnName = (path: KeyPath) => (path.length === 0 ? VALUE_COLUMN_NAME : path.join("."));

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) && !ArrayBuffer.isView(value) && !(value instanceof Date);
}

// A value at this depth is split into child columns instead of shown in one cell.
function splits(value: unknown, depth: number): boolean {
  if (!isRecord(value)) return false;
  if (depth === 0) return true;
  if (depth >= DATA_MAX_DEPTH) return false;
  for (const _ in value) return true;
  return false;
}

interface ColumnNode {
  children: Map<string, ColumnNode>;
  leaf: boolean;
}

const node = (): ColumnNode => ({ children: new Map(), leaf: false });

// Collects the union of key paths in first-seen order, keeping the children of a key together.
export class ColumnCollector {
  private readonly root = node();
  private count = 0;
  truncated = false;

  add(record: unknown): void {
    if (splits(record, 0)) this.walk(record as Record<string, unknown>, this.root, 0);
    else this.mark(this.root);
  }

  hasTopLevelKey(key: string): boolean {
    return this.root.children.has(key);
  }

  columns(): string[][] {
    const out: string[][] = [];
    const visit = (current: ColumnNode, path: string[]) => {
      if (current.leaf) out.push(path);
      for (const [key, child] of current.children) visit(child, [...path, key]);
    };
    for (const [key, child] of this.root.children) visit(child, [key]);
    if (this.root.leaf) out.push([]);
    return out;
  }

  private mark(target: ColumnNode): boolean {
    if (target.leaf) return true;
    if (this.count >= DATA_MAX_COLUMNS) {
      this.truncated = true;
      return false;
    }
    target.leaf = true;
    this.count++;
    return true;
  }

  private walk(object: Record<string, unknown>, parent: ColumnNode, depth: number): void {
    for (const key in object) {
      let child = parent.children.get(key);
      if (!child) {
        if (this.count >= DATA_MAX_COLUMNS) {
          this.truncated = true;
          continue;
        }
        child = node();
        parent.children.set(key, child);
      }
      const value = object[key];
      if (splits(value, depth + 1)) this.walk(value as Record<string, unknown>, child, depth + 1);
      else this.mark(child);
    }
  }
}

// The value a column shows for a record, or undefined when the record has nothing there. A value
// split into child columns is not repeated in its parent's column.
export function valueAt(record: unknown, path: KeyPath): unknown {
  let value = record;
  for (const key of path) {
    if (!isRecord(value) || !Object.prototype.hasOwnProperty.call(value, key)) return undefined;
    value = value[key];
  }
  return splits(value, path.length) ? undefined : value;
}

export function valueType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (value instanceof Date) return "timestamp";
  if (ArrayBuffer.isView(value)) return "binary";
  if (typeof value === "bigint") return "number";
  return typeof value;
}

const STOP = Symbol("stop");

// JSON text of a value, cut at `maxChars` without serializing the rest.
export function boundedJson(value: unknown, maxChars: number, indent = 0): { text: string; truncated: boolean } {
  const parts: string[] = [];
  let length = 0;
  let truncated = false;
  const push = (text: string) => {
    parts.push(text);
    length += text.length;
    if (length > maxChars) {
      truncated = true;
      throw STOP;
    }
  };
  const newline = (level: number) => (indent > 0 ? `\n${" ".repeat(indent * level)}` : "");
  const write = (current: unknown, level: number): void => {
    if (current === null || current === undefined) return push("null");
    if (typeof current === "bigint") return push(current.toString());
    if (typeof current === "number") return push(Number.isFinite(current) ? String(current) : JSON.stringify(String(current)));
    if (typeof current === "boolean") return push(String(current));
    if (typeof current === "string") {
      const room = maxChars - length + 2;
      return push(JSON.stringify(current.length > room ? current.slice(0, room) : current));
    }
    if (current instanceof Date) return push(JSON.stringify(Number.isNaN(current.getTime()) ? String(current) : current.toISOString()));
    if (ArrayBuffer.isView(current)) return push(JSON.stringify(`binary, ${current.byteLength} bytes`));
    if (Array.isArray(current)) {
      if (current.length === 0) return push("[]");
      push("[");
      current.forEach((item, index) => {
        if (index > 0) push(",");
        push(newline(level + 1));
        write(item, level + 1);
      });
      push(newline(level));
      return push("]");
    }
    if (typeof current === "object") {
      const entries = Object.entries(current as Record<string, unknown>).filter(([, item]) => item !== undefined);
      if (entries.length === 0) return push("{}");
      push("{");
      entries.forEach(([key, item], index) => {
        if (index > 0) push(",");
        push(newline(level + 1));
        push(`${JSON.stringify(key)}:${indent > 0 ? " " : ""}`);
        write(item, level + 1);
      });
      push(newline(level));
      return push("}");
    }
    return push(JSON.stringify(String(current)));
  };
  try {
    write(value, 0);
  } catch (error) {
    if (error !== STOP) throw error;
  }
  const text = parts.join("");
  return truncated ? { text: text.slice(0, maxChars), truncated } : { text, truncated };
}

const clip = (text: string, max: number) => (text.length > max ? { text: text.slice(0, max), truncated: true } : { text, truncated: false });

// What the grid shows for a value: text as is, numbers and booleans as written, arrays with their length first.
export function cellText(value: unknown, max = XLSX_MAX_CELL_CHARS): { text: string; truncated: boolean } {
  if (value === undefined) return { text: "", truncated: false };
  if (typeof value === "string") return clip(value, max);
  if (value === null || typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return clip(String(value), max);
  if (value instanceof Date) return { text: Number.isNaN(value.getTime()) ? String(value) : value.toISOString(), truncated: false };
  if (ArrayBuffer.isView(value)) return { text: `binary, ${value.byteLength} bytes`, truncated: false };
  if (Array.isArray(value) && value.length > 0) {
    const prefix = `${value.length} ${value.length === 1 ? "item" : "items"}: `;
    const json = boundedJson(value, Math.max(0, max - prefix.length));
    return { text: prefix + json.text, truncated: json.truncated };
  }
  return boundedJson(value, max);
}

export interface FullValue {
  text: string;
  format: "text" | "json";
  truncated: boolean;
  length?: number;
}

// The inspector's full value: text in full and structured values as indented JSON, up to CELL_FULL_MAX_CHARS.
export function fullValue(value: unknown, max = CELL_FULL_MAX_CHARS): FullValue {
  if (typeof value === "string") return { ...clip(value, max), format: "text", length: value.length };
  if (Array.isArray(value) || isRecord(value)) return { ...boundedJson(value, max, 2), format: "json" };
  return { ...cellText(value, max), format: "text" };
}

export interface ParsedRecord {
  line?: number;
  value?: unknown;
  error?: string;
  text?: string;
}

export interface RecordCells {
  cells: string[];
  details: (CellDetail | null)[];
}

// One record's cells for `columns`; an unreadable record shows its error in the first cell.
export function recordCells(record: ParsedRecord, columns: readonly KeyPath[], detail: boolean, describe?: (path: KeyPath) => string): RecordCells {
  const cells = new Array<string>(columns.length).fill("");
  const details: (CellDetail | null)[] = detail ? new Array<CellDetail | null>(columns.length).fill(null) : [];
  const line = record.line !== undefined ? { line: record.line } : {};
  if (record.error !== undefined) {
    if (columns.length === 0) return { cells, details };
    const display = clip(`Invalid JSON: ${record.error}`, XLSX_MAX_CELL_CHARS).text;
    cells[0] = display;
    if (detail) {
      const raw = clip(record.text ?? "", XLSX_MAX_CELL_CHARS);
      details[0] = { type: "json", raw: raw.text, display, valueType: "invalid", error: record.error, ...line, ...(raw.truncated ? { truncated: true } : {}) };
    }
    return { cells, details };
  }
  columns.forEach((path, index) => {
    const value = valueAt(record.value, path);
    if (value === undefined) return;
    const shown = cellText(value);
    cells[index] = shown.text;
    if (!detail) return;
    const raw = typeof value === "string" ? shown : boundedJson(value, XLSX_MAX_CELL_CHARS);
    details[index] = {
      type: "json",
      raw: raw.text,
      display: shown.text,
      valueType: describe ? describe(path) : valueType(value),
      keyPath: columnName(path),
      ...line,
      ...(shown.truncated || raw.truncated ? { truncated: true } : {}),
    };
  });
  return { cells, details };
}
