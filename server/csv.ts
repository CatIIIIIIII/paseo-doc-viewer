import { createReadStream } from "node:fs";
import { MAX_RESPONSE_BYTES, XLSX_MAX_CELL_CHARS, XLSX_MAX_COLUMNS, XLSX_MAX_ROWS } from "../shared/limits";
import { ERROR_MESSAGES } from "../shared/errors";
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

const clip = (text: string) => (text.length > XLSX_MAX_CELL_CHARS ? text.slice(0, XLSX_MAX_CELL_CHARS) : text);

function decodeCell(bytes: Buffer, truncated: boolean): string {
  for (let cut = 0; cut <= (truncated ? 3 : 0); cut++) {
    try {
      return clip(utf8.decode(bytes.subarray(0, bytes.length - cut)));
    } catch {}
  }
  return clip(bytes.toString("latin1"));
}

async function scanCsv(path: string, start: number, delimiter: number, visitor: Visitor): Promise<void> {
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
    const end = Math.min(to, from + MAX_CELL_BYTES - partBytes);
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

export async function csvWindow(
  path: string,
  index: CsvIndex,
  rowOffset: number,
  columnOffset: number,
  maxColumns = XLSX_MAX_COLUMNS,
  maxRows = XLSX_MAX_ROWS,
): Promise<RowWindow> {
  const { rowCount, columnCount } = index;
  const rowEnd = Math.min(rowCount, rowOffset + maxRows);
  const columnEnd = Math.min(columnCount, columnOffset + maxColumns);
  const rows: string[][] = [];
  let bytes = 0;
  if (rowOffset < rowEnd) {
    const checkpoint = Math.min(Math.floor(rowOffset / CHECKPOINT_ROWS), index.checkpoints.length - 1);
    let row = checkpoint * CHECKPOINT_ROWS;
    let current = new Array<string>(Math.max(0, columnEnd - columnOffset)).fill("");
    const deadline = Date.now() + WINDOW_DEADLINE_MS;
    await scanCsv(path, index.checkpoints[checkpoint]!, index.delimiter, {
      wants: (column) => row >= rowOffset && column >= columnOffset && column < columnEnd,
      cell: (column, value, truncated) => {
        current[column - columnOffset] = decodeCell(value, truncated);
      },
      row: () => {
        if (row >= rowOffset) {
          const rowBytes = Buffer.byteLength(JSON.stringify(current), "utf8") + 1;
          if (rows.length > 0 && bytes + rowBytes > ROWS_BUDGET_BYTES) return false;
          rows.push(current);
          bytes += rowBytes;
          current = new Array<string>(current.length).fill("");
        }
        row++;
        if (row % 4096 === 0 && Date.now() > deadline) throw new Error(ERROR_MESSAGES.slowWindow());
        return row < rowEnd;
      },
    });
  }
  const next = rowOffset + rows.length;
  return {
    rowCount,
    columnCount,
    countsApproximate: false,
    rows,
    nextRowOffset: next < rowCount ? next : null,
    nextColumnOffset: columnEnd < columnCount ? columnEnd : null,
  };
}
