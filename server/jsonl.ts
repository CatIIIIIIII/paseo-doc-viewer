import { createReadStream } from "node:fs";
import { CELL_FULL_MAX_CHARS, DATA_SAMPLE_ROWS, MAX_RESPONSE_BYTES, XLSX_MAX_COLUMNS, XLSX_MAX_ROWS } from "../shared/limits";
import { ERROR_MESSAGES } from "../shared/errors";
import type { CellDetail } from "../shared/rpc";
import { boundedJson, ColumnCollector, columnName, fullValue, isRecord, recordCells, type FullValue, type KeyPath, type ParsedRecord } from "./data-table";
import type { RowWindow } from "./xlsx";

// JSON Lines (.jsonl, .ndjson): one JSON value per line. Blank lines are skipped, so a row is the
// n-th non-blank line. One indexing pass counts rows, keeps a byte offset every CHECKPOINT_ROWS rows,
// takes columns from the first DATA_SAMPLE_ROWS records and parses every line to list unreadable ones.

export interface JsonlCheckpoint {
  offset: number;
  line: number;
}

export interface JsonlIssue {
  row: number;
  line: number;
  kind: "invalid-json" | "unlisted-key";
  message: string;
}

export interface JsonlIndex {
  rowCount: number;
  columns: string[][];
  columnsTruncated: boolean;
  checkpoints: JsonlCheckpoint[];
  issues: JsonlIssue[];
  omittedIssues: number;
}

const LF = 0x0a;
const BOM = [0xef, 0xbb, 0xbf];
const CHECKPOINT_ROWS = XLSX_MAX_ROWS;
const READ_CHUNK_BYTES = 1024 * 1024;
export const JSONL_MAX_LINE_BYTES = 16 * 1024 * 1024;
export const JSONL_MAX_ISSUES = 1000;
const MAX_UNLISTED_KEYS = 50;
const INDEX_DEADLINE_MS = 18_000;
const WINDOW_DEADLINE_MS = 18_000;
const ROWS_BUDGET_BYTES = MAX_RESPONSE_BYTES - 64 * 1024;
const BLANK = /^\s*$/;

interface Line {
  row: number;
  line: number;
  offset: number;
  // null when the line is longer than JSONL_MAX_LINE_BYTES and was not read.
  text: string | null;
}

// Streams the non-blank lines from `start`; `visit` returns false to stop. Memory holds one line at a time.
async function scanLines(path: string, start: JsonlCheckpoint, firstRow: number, visit: (line: Line) => boolean): Promise<void> {
  let parts: Buffer[] = [];
  let bytes = 0;
  let tooLong = false;
  let position = start.offset;
  let lineStart = start.offset;
  let lineNumber = start.line;
  let row = firstRow;
  let stopped = false;
  const emit = () => {
    let text: string | null = null;
    if (!tooLong) {
      text = parts.length === 1 ? parts[0]!.toString("utf8") : Buffer.concat(parts, bytes).toString("utf8");
      if (text.endsWith("\r")) text = text.slice(0, -1);
    }
    const blank = text !== null && BLANK.test(text);
    if (!blank && !visit({ row: row++, line: lineNumber, offset: lineStart, text })) stopped = true;
    lineNumber++;
    parts = [];
    bytes = 0;
    tooLong = false;
  };
  const stream = createReadStream(path, { start: start.offset, highWaterMark: READ_CHUNK_BYTES });
  try {
    for await (const chunk of stream as AsyncIterable<Buffer>) {
      let i = 0;
      if (position === 0 && BOM.every((byte, b) => chunk[b] === byte)) i = lineStart = BOM.length;
      while (i < chunk.length) {
        const lf = chunk.indexOf(LF, i);
        const end = lf === -1 ? chunk.length : lf;
        if (!tooLong && end > i) {
          if (bytes + end - i > JSONL_MAX_LINE_BYTES) {
            tooLong = true;
            parts = [];
          } else {
            parts.push(chunk.subarray(i, end));
            bytes += end - i;
          }
        }
        if (lf === -1) break;
        emit();
        if (stopped) return;
        i = lf + 1;
        lineStart = position + i;
      }
      position += chunk.length;
    }
    if (bytes > 0 || tooLong) emit();
  } finally {
    stream.destroy();
  }
}

const LONG_INTEGER = /\d{16,}/;
const INTEGER_SOURCE = /^-?\d+$/;

// Integers beyond 2^53 keep their digits (as bigint) where the runtime exposes the source text.
function keepLongIntegers(this: unknown, _key: string, value: unknown, context?: { source?: string }): unknown {
  if (typeof value === "number" && !Number.isSafeInteger(value) && context?.source && INTEGER_SOURCE.test(context.source)) return BigInt(context.source);
  return value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const tooLongMessage = () => `Line is longer than ${JSONL_MAX_LINE_BYTES / (1024 * 1024)} MB and is not read`;

export function parseLine(line: Line, exact = true): ParsedRecord {
  if (line.text === null) return { line: line.line, error: tooLongMessage(), text: "" };
  try {
    const value: unknown = exact && LONG_INTEGER.test(line.text)
      ? JSON.parse(line.text, keepLongIntegers as (key: string, value: unknown) => unknown)
      : JSON.parse(line.text);
    return { line: line.line, value };
  } catch (error) {
    return { line: line.line, error: errorMessage(error), text: line.text };
  }
}

export async function indexJsonl(path: string, deadline = Date.now() + INDEX_DEADLINE_MS): Promise<JsonlIndex> {
  const collector = new ColumnCollector();
  const index: JsonlIndex = { rowCount: 0, columns: [], columnsTruncated: false, checkpoints: [{ offset: 0, line: 1 }], issues: [], omittedIssues: 0 };
  const unlisted = new Set<string>();
  const issue = (found: JsonlIssue) => {
    if (index.issues.length < JSONL_MAX_ISSUES) index.issues.push(found);
    else index.omittedIssues++;
  };
  await scanLines(path, index.checkpoints[0]!, 0, (line) => {
    if (line.row > 0 && line.row % CHECKPOINT_ROWS === 0) index.checkpoints.push({ offset: line.offset, line: line.line });
    if (line.row % 1024 === 0 && Date.now() > deadline) throw new Error(ERROR_MESSAGES.tooSlow());
    index.rowCount = line.row + 1;
    const parsed = parseLine(line, false);
    if (parsed.error !== undefined) {
      issue({ row: line.row, line: line.line, kind: "invalid-json", message: parsed.error });
      return true;
    }
    if (line.row < DATA_SAMPLE_ROWS) collector.add(parsed.value);
    else if (isRecord(parsed.value) && unlisted.size < MAX_UNLISTED_KEYS) {
      for (const key in parsed.value) {
        if (collector.hasTopLevelKey(key) || unlisted.has(key) || unlisted.size >= MAX_UNLISTED_KEYS) continue;
        unlisted.add(key);
        issue({ row: line.row, line: line.line, kind: "unlisted-key", message: `Key "${key}" first appears after the first ${DATA_SAMPLE_ROWS.toLocaleString("en-US")} records and has no column` });
      }
    }
    return true;
  });
  index.columns = collector.columns();
  index.columnsTruncated = collector.truncated;
  return index;
}

// Streams parsed records from the checkpoint at or before `fromRow`; rows before it are not parsed.
export async function jsonlRecords(
  path: string,
  index: JsonlIndex,
  fromRow: number,
  deadline: number,
  visit: (row: number, record: ParsedRecord) => boolean,
): Promise<void> {
  const checkpoint = Math.min(Math.floor(fromRow / CHECKPOINT_ROWS), index.checkpoints.length - 1);
  let seen = 0;
  await scanLines(path, index.checkpoints[checkpoint]!, checkpoint * CHECKPOINT_ROWS, (line) => {
    if (++seen % 1024 === 0 && Date.now() > deadline) throw new Error(ERROR_MESSAGES.slowWindow());
    if (line.row < fromRow) return true;
    return visit(line.row, parseLine(line));
  });
}

export async function jsonlWindow(
  path: string,
  index: JsonlIndex,
  rowOffset: number,
  columnOffset: number,
  maxColumns = XLSX_MAX_COLUMNS,
  maxRows = XLSX_MAX_ROWS,
  detail = false,
): Promise<RowWindow & { columnNames: string[] }> {
  const { rowCount } = index;
  const columnCount = index.columns.length;
  const rowEnd = Math.min(rowCount, rowOffset + maxRows);
  const columnEnd = Math.min(columnCount, columnOffset + maxColumns);
  const columns: KeyPath[] = index.columns.slice(columnOffset, columnEnd);
  const rows: string[][] = [];
  const details: (CellDetail | null)[][] = [];
  let bytes = 0;
  if (rowOffset < rowEnd && columns.length > 0) {
    await jsonlRecords(path, index, rowOffset, Date.now() + WINDOW_DEADLINE_MS, (row, record) => {
      const { cells, details: rowDetails } = recordCells(record, columns, detail);
      const rowBytes = Buffer.byteLength(JSON.stringify(cells), "utf8") + (detail ? Buffer.byteLength(JSON.stringify(rowDetails), "utf8") : 0) + 2;
      if (rows.length > 0 && bytes + rowBytes > ROWS_BUDGET_BYTES) return false;
      rows.push(cells);
      if (detail) details.push(rowDetails);
      bytes += rowBytes;
      return row + 1 < rowEnd;
    });
  }
  const next = rowOffset + rows.length;
  return {
    rowCount,
    columnCount,
    countsApproximate: false,
    rows,
    ...(detail ? { details } : {}),
    columnNames: columns.map(columnName),
    nextRowOffset: next < rowCount ? next : null,
    nextColumnOffset: columnEnd < columnCount ? columnEnd : null,
  };
}

async function jsonlRecord(path: string, index: JsonlIndex, row: number): Promise<ParsedRecord> {
  let found: ParsedRecord | null = null;
  await jsonlRecords(path, index, row, Date.now() + WINDOW_DEADLINE_MS, (_, record) => {
    found = record;
    return false;
  });
  if (!found) throw new Error(ERROR_MESSAGES.outOfRange("Row", row, index.rowCount));
  return found;
}

// One cell in full, or with `column` null the whole record as indented JSON (or the line's text when it is not valid JSON).
export async function jsonlFullValue(path: string, index: JsonlIndex, row: number, column: number | null): Promise<FullValue & { line?: number }> {
  if (row >= index.rowCount) throw new Error(ERROR_MESSAGES.outOfRange("Row", row, index.rowCount));
  if (column !== null && column >= index.columns.length) throw new Error(ERROR_MESSAGES.outOfRange("Column", column, index.columns.length));
  const record = await jsonlRecord(path, index, row);
  const line = record.line !== undefined ? { line: record.line } : {};
  if (record.error !== undefined) return { ...fullValue(record.text ?? ""), ...line };
  if (column === null) return { ...boundedJson(record.value, CELL_FULL_MAX_CHARS, 2), format: "json", ...line };
  let value: unknown = record.value;
  for (const key of index.columns[column]!) value = isRecord(value) ? value[key] : undefined;
  return { ...fullValue(value), ...line };
}
