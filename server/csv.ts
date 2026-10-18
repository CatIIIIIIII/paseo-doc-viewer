import { createReadStream } from "node:fs";
import { CELL_FULL_MAX_CHARS, MAX_RESPONSE_BYTES, XLSX_MAX_CELL_CHARS, XLSX_MAX_COLUMNS, XLSX_MAX_ROWS } from "../shared/limits";
import { ERROR_MESSAGES } from "../shared/errors";
import type { CellDetail } from "../shared/rpc";
import type { RowWindow } from "./xlsx";

export interface CsvIndex {
  delimiter: number;
  rowCount: number;
  columnCount: number;
  checkpoints: number[];
}

const QUOTE = 0x22;
const LF = 0x0a;
const CR = 0x0d;
const TAB = 0x09;
const COMMA = 0x2c;
const BOM = [0xef, 0xbb, 0xbf];
const CHECKPOINT_ROWS = XLSX_MAX_ROWS;
const ROWS_BUDGET_BYTES = MAX_RESPONSE_BYTES - 64 * 1024;
const MAX_CELL_BYTES = XLSX_MAX_CELL_CHARS * 4;
const READ_CHUNK_BYTES = 256 * 1024;
const WINDOW_DEADLINE_MS = 20_000;

const enum State {
  FieldStart,
  Unquoted,
  Quoted,
  QuoteInQuoted,
  AfterCr,
}

interface Visitor {
  wants(column: number): boolean;
  cell(column: number, bytes: Buffer, truncated: boolean): void;
  row(nextRowStart: number): boolean;
}

export function delimiterFor(extension: string): number {
  return extension === "tsv" ? TAB : COMMA;
}

const utf8 = new TextDecoder("utf-8", { fatal: true });

interface DecodedCell {
  text: string;
  // The stored field is longer than `text`.
  truncated: boolean;
}

function decodeField(bytes: Buffer, truncated: boolean, maxChars: number): DecodedCell {
  const clip = (text: string) => (text.length > maxChars ? { text: text.slice(0, maxChars), truncated: true } : { text, truncated });
  for (let cut = 0; cut <= (truncated ? 3 : 0); cut++) {
    try {
      return clip(utf8.decode(bytes.subarray(0, bytes.length - cut)));
    } catch {}
  }
  return clip(bytes.toString("latin1"));
}

const decodeCell = (bytes: Buffer, truncated: boolean) => decodeField(bytes, truncated, XLSX_MAX_CELL_CHARS);

async function scanCsv(path: string, start: number, delimiter: number, visitor: Visitor, maxCellBytes = MAX_CELL_BYTES): Promise<void> {
  let state = State.FieldStart;
  let column = 0;
  let rowOpen = false;
  let collecting = visitor.wants(0);
  let parts: Buffer[] = [];
  let partBytes = 0;
  let truncated = false;
  let stopped = false;

  const append = (chunk: Buffer, from: number, to: number) => {
    if (!collecting || to <= from) return;
    const end = Math.min(to, from + maxCellBytes - partBytes);
    if (end < to) truncated = true;
    if (end <= from) return;
    parts.push(chunk.subarray(from, end));
    partBytes += end - from;
  };
  const endField = () => {
    if (collecting) visitor.cell(column, Buffer.concat(parts, partBytes), truncated);
    parts = [];
    partBytes = 0;
    truncated = false;
  };
  const nextField = () => {
    endField();
    column++;
    collecting = visitor.wants(column);
    state = State.FieldStart;
  };
  const endRow = (nextRowStart: number) => {
    endField();
    column = 0;
    rowOpen = false;
    state = State.FieldStart;
    if (!visitor.row(nextRowStart)) stopped = true;
    collecting = visitor.wants(0);
  };

  let offset = start;
  const stream = createReadStream(path, { start, highWaterMark: READ_CHUNK_BYTES });
  try {
    for await (const chunk of stream as AsyncIterable<Buffer>) {
      let i = 0;
      if (offset === 0 && BOM.every((byte, b) => chunk[b] === byte)) i = BOM.length;
      let run = i;
      for (; i < chunk.length && !stopped; i++) {
        const byte = chunk[i]!;
        switch (state) {
          case State.Quoted:
            if (byte === QUOTE) {
              append(chunk, run, i);
              state = State.QuoteInQuoted;
            }
            continue;
          case State.QuoteInQuoted:
            if (byte === QUOTE) {
              run = i;
              state = State.Quoted;
              continue;
            }
            state = State.Unquoted;
            run = i;
            break;
          case State.AfterCr:
            if (byte === LF) {
              endRow(offset + i + 1);
              run = i + 1;
              continue;
            }
            endRow(offset + i);
            i--;
            continue;
          case State.FieldStart:
            rowOpen = true;
            if (byte === QUOTE) {
              state = State.Quoted;
              run = i + 1;
              continue;
            }
            run = i;
            state = State.Unquoted;
            break;
          case State.Unquoted:
            break;
        }
        rowOpen = true;
        if (byte === delimiter) {
          append(chunk, run, i);
          nextField();
          run = i + 1;
        } else if (byte === LF) {
          append(chunk, run, i);
          endRow(offset + i + 1);
          run = i + 1;
        } else if (byte === CR) {
          append(chunk, run, i);
          state = State.AfterCr;
        }
      }
      if (stopped) return;
      if (state === State.Unquoted || state === State.Quoted) append(chunk, run, chunk.length);
      offset += chunk.length;
    }
    if (rowOpen) endRow(offset);
  } finally {
    stream.destroy();
  }
}

export async function indexCsv(path: string, extension: string): Promise<CsvIndex> {
  const delimiter = delimiterFor(extension);
  const index: CsvIndex = { delimiter, rowCount: 0, columnCount: 0, checkpoints: [0] };
  let columns = 0;
  await scanCsv(path, 0, delimiter, {
    wants: (column) => {
      columns = column + 1;
      return false;
    },
    cell: () => {},
    row: (nextRowStart) => {
      index.rowCount++;
      index.columnCount = Math.max(index.columnCount, columns);
      if (index.rowCount % CHECKPOINT_ROWS === 0) index.checkpoints.push(nextRowStart);
      return true;
    },
  });
  return index;
}

// Streams rows from the checkpoint at or before `fromRow`, decoding only the requested columns.
export async function csvRows(
  path: string,
  index: CsvIndex,
  fromRow: number,
  columnStart: number,
  columnEnd: number,
  deadline: number,
  visit: (row: number, cells: string[], truncated: ReadonlySet<number>) => boolean,
): Promise<void> {
  const checkpoint = Math.min(Math.floor(fromRow / CHECKPOINT_ROWS), index.checkpoints.length - 1);
  let row = checkpoint * CHECKPOINT_ROWS;
  let current = new Array<string>(Math.max(0, columnEnd - columnStart)).fill("");
  let cut = new Set<number>();
  await scanCsv(path, index.checkpoints[checkpoint]!, index.delimiter, {
    wants: (column) => row >= fromRow && column >= columnStart && column < columnEnd,
    cell: (column, value, truncated) => {
      const decoded = decodeCell(value, truncated);
      current[column - columnStart] = decoded.text;
      if (decoded.truncated) cut.add(column - columnStart);
    },
    row: () => {
      let more = true;
      if (row >= fromRow) {
        more = visit(row, current, cut);
        current = new Array<string>(current.length).fill("");
        if (cut.size > 0) cut = new Set();
      }
      row++;
      if (row % 4096 === 0 && Date.now() > deadline) throw new Error(ERROR_MESSAGES.slowWindow());
      return more;
    },
  });
}

// Streams the non-empty cells of each row from `fromRow` in column order. Unlike csvRows it never
// allocates a row-wide array, so a wide file with blank rows costs time in proportion to its bytes.
export async function csvCells(
  path: string,
  index: CsvIndex,
  fromRow: number,
  visit: (row: number, cells: (readonly [number, string])[]) => boolean,
): Promise<void> {
  const checkpoint = Math.min(Math.floor(fromRow / CHECKPOINT_ROWS), index.checkpoints.length - 1);
  let row = checkpoint * CHECKPOINT_ROWS;
  let cells: (readonly [number, string])[] = [];
  await scanCsv(path, index.checkpoints[checkpoint]!, index.delimiter, {
    wants: () => row >= fromRow,
    cell: (column, value, truncated) => {
      if (value.length > 0) cells.push([column, decodeCell(value, truncated).text]);
    },
    row: () => {
      let more = true;
      if (row >= fromRow) {
        more = visit(row, cells);
        cells = [];
      }
      row++;
      return more;
    },
  });
}

export async function csvWindow(
  path: string,
  index: CsvIndex,
  rowOffset: number,
  columnOffset: number,
  maxColumns = XLSX_MAX_COLUMNS,
  maxRows = XLSX_MAX_ROWS,
  detail = false,
): Promise<RowWindow> {
  const { rowCount, columnCount } = index;
  const rowEnd = Math.min(rowCount, rowOffset + maxRows);
  const columnEnd = Math.min(columnCount, columnOffset + maxColumns);
  const rows: string[][] = [];
  const details: (CellDetail | null)[][] = [];
  let bytes = 0;
  if (rowOffset < rowEnd) {
    await csvRows(path, index, rowOffset, columnOffset, columnEnd, Date.now() + WINDOW_DEADLINE_MS, (row, cells, truncated) => {
      const rowDetails = detail
        ? cells.map((text, column) => (text ? { type: "text" as const, raw: text, display: text, ...(truncated.has(column) ? { truncated: true } : {}) } : null))
        : [];
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
    nextRowOffset: next < rowCount ? next : null,
    nextColumnOffset: columnEnd < columnCount ? columnEnd : null,
  };
}

// One field without the grid's cut, up to CELL_FULL_MAX_CHARS characters.
export async function csvFullCell(path: string, index: CsvIndex, row: number, column: number): Promise<{ text: string; truncated: boolean; length?: number }> {
  const checkpoint = Math.min(Math.floor(row / CHECKPOINT_ROWS), index.checkpoints.length - 1);
  let current = checkpoint * CHECKPOINT_ROWS;
  let found: DecodedCell = { text: "", truncated: false };
  const deadline = Date.now() + WINDOW_DEADLINE_MS;
  await scanCsv(path, index.checkpoints[checkpoint]!, index.delimiter, {
    wants: (candidate) => current === row && candidate === column,
    cell: (_, value, truncated) => {
      found = decodeField(value, truncated, CELL_FULL_MAX_CHARS);
    },
    row: () => {
      current++;
      if (current % 4096 === 0 && Date.now() > deadline) throw new Error(ERROR_MESSAGES.slowWindow());
      return current <= row;
    },
  }, CELL_FULL_MAX_CHARS * 4);
  return found.truncated ? found : { ...found, length: found.text.length };
}
