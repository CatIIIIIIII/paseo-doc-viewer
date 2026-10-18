import { open } from "node:fs/promises";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { decompress as zstdDecompress } from "fzstd";
import { parquetMetadataAsync, parquetRead, parquetSchema } from "hyparquet";
import type { AsyncBuffer, Compressors, FileMetaData, SchemaElement, SchemaTree } from "hyparquet";
import { decompressLz4, decompressLz4Raw } from "hyparquet-compressors/src/lz4.js";
import { CELL_FULL_MAX_CHARS, DATA_MAX_COLUMNS, DATA_MAX_DEPTH, MAX_RESPONSE_BYTES, XLSX_MAX_COLUMNS, XLSX_MAX_ROWS } from "../shared/limits";
import { ERROR_MESSAGES } from "../shared/errors";
import type { CellDetail } from "../shared/rpc";
import { boundedJson, columnName, fullValue, isRecord, recordCells, type FullValue, type KeyPath } from "./data-table";
import type { RowWindow } from "./xlsx";

// Parquet through hyparquet (pure JavaScript). Only the footer is read to open a file; a page of rows
// reads the row groups it overlaps, limited to the columns on screen. Snappy is built into hyparquet;
// gzip and Brotli use node:zlib, Zstandard uses fzstd and LZ4 the hyparquet-compressors decoder. LZO is not supported.

export interface ParquetColumn {
  path: string[];
  type: string;
}

export interface ParquetModel {
  metadata: FileMetaData;
  rowCount: number;
  columns: ParquetColumn[];
  columnsTruncated: boolean;
}

const MAX_FOOTER_BYTES = 32 * 1024 * 1024;
// Compressed plus uncompressed bytes of the column chunks one row group read may hold; page-indexed chunks
// count compressed bytes only, because only the pages in range are read. Without a page index hyparquet
// decodes whole column chunks. Measured on single-row-group snappy files of text-heavy rows (bench in the
// 0.5.0 integration notes): at about 60 MiB per group one grid window peaks about 70 MiB above the process
// baseline, two concurrent windows about 135 MiB and a full Find about 145 MiB, inside a 200 MiB target.
// A plugin process that runs out of memory is not restarted, so a larger group is refused, not attempted.
export const PARQUET_MAX_READ_BYTES = 64 * 1024 * 1024;
const ROWS_BUDGET_BYTES = MAX_RESPONSE_BYTES - 64 * 1024;
const SEARCH_BATCH_ROWS = 2_000;

const compressors: Compressors = {
  GZIP: (input) => new Uint8Array(gunzipSync(input)),
  BROTLI: (input) => new Uint8Array(brotliDecompressSync(input)),
  ZSTD: (input) => zstdDecompress(input),
  LZ4: decompressLz4,
  LZ4_RAW: decompressLz4Raw,
};

// Reads byte ranges on demand through one file handle, closed when the work is done.
async function withFile<T>(path: string, size: number, work: (file: AsyncBuffer) => Promise<T>): Promise<T> {
  const handle = await open(path, "r");
  try {
    return await work({
      byteLength: size,
      slice: async (start, end = size) => {
        const bytes = new Uint8Array(Math.max(0, end - start));
        let read = 0;
        while (read < bytes.length) {
          const { bytesRead } = await handle.read(bytes, read, bytes.length - read, start + read);
          if (bytesRead === 0) throw new Error(ERROR_MESSAGES.invalidOffice("parquet"));
          read += bytesRead;
        }
        return bytes.buffer;
      },
    });
  } finally {
    await handle.close();
  }
}

const TIME_UNITS: Readonly<Record<string, string>> = { MILLIS: "milliseconds", MICROS: "microseconds", NANOS: "nanoseconds" };

function primitiveType(element: SchemaElement): string {
  const physical = element.type ?? "group";
  const logical = element.logical_type;
  const named = (() => {
    switch (logical?.type) {
      case "STRING": return "string";
      case "ENUM": return "enum";
      case "JSON": return "JSON text";
      case "BSON": return "BSON";
      case "UUID": return "UUID";
      case "DATE": return "date";
      case "FLOAT16": return "float16";
      case "INTERVAL": return "interval";
      case "DECIMAL": return `decimal(${logical.precision}, ${logical.scale})`;
      case "INTEGER": return `${logical.isSigned ? "int" : "uint"}${logical.bitWidth}`;
      case "TIME": return `time, ${TIME_UNITS[String(Object.keys(logical.unit ?? {})[0] ?? logical.unit)] ?? String(logical.unit)}`;
      case "TIMESTAMP": {
        const unit = typeof logical.unit === "string" ? logical.unit : Object.keys(logical.unit ?? {})[0] ?? "";
        return `timestamp, ${TIME_UNITS[unit] ?? unit.toLowerCase()}${logical.isAdjustedToUTC ? ", UTC" : ""}`;
      }
      case "GEOMETRY": return "geometry";
      case "GEOGRAPHY": return "geography";
      case "VARIANT": return "variant";
    }
    switch (element.converted_type) {
      case "UTF8": return "string";
      case "DATE": return "date";
      case "TIMESTAMP_MILLIS": return "timestamp, milliseconds";
      case "TIMESTAMP_MICROS": return "timestamp, microseconds";
      case "DECIMAL": return `decimal(${element.precision ?? "?"}, ${element.scale ?? 0})`;
      case "JSON": return "JSON text";
    }
    switch (physical) {
      case "BOOLEAN": return "boolean";
      case "INT32": return "int32";
      case "INT64": return "int64";
      case "INT96": return "timestamp (INT96)";
      case "FLOAT": return "float";
      case "DOUBLE": return "double";
      case "BYTE_ARRAY": return "binary";
      case "FIXED_LEN_BYTE_ARRAY": return `binary(${element.type_length ?? "?"})`;
    }
    return physical.toLowerCase();
  })();
  return physical === "group" ? named : `${named} (Parquet ${physical})`;
}

const annotated = (element: SchemaElement, kind: "LIST" | "MAP") =>
  element.logical_type?.type === kind || element.converted_type === kind || (kind === "MAP" && element.converted_type === "MAP_KEY_VALUE");

// LIST is a group holding a repeated group (or field) holding the element.
function listElement(node: SchemaTree): SchemaTree | undefined {
  const repeated = node.children[0];
  if (!repeated) return undefined;
  return repeated.children.length === 1 && repeated.element.name !== "array" && !repeated.element.name.endsWith("_tuple") ? repeated.children[0] : repeated;
}

function describe(node: SchemaTree): string {
  const { element } = node;
  const required = element.repetition_type === "REQUIRED" ? ", required" : "";
  if (node.children.length === 0) return primitiveType(element) + required;
  if (annotated(element, "LIST")) {
    const item = listElement(node);
    return `list of ${item ? describe(item).replace(/, required$/, "") : "values"}${required}`;
  }
  if (annotated(element, "MAP")) return `map${required}`;
  if (element.repetition_type === "REPEATED") return `repeated group${required}`;
  return `struct${required}`;
}

function schemaColumns(metadata: FileMetaData): { columns: ParquetColumn[]; truncated: boolean } {
  const columns: ParquetColumn[] = [];
  let truncated = false;
  const visit = (node: SchemaTree, path: string[]) => {
    if (columns.length >= DATA_MAX_COLUMNS) {
      truncated = true;
      return;
    }
    const { element } = node;
    const group = node.children.length > 0;
    const splits = group && !annotated(element, "LIST") && !annotated(element, "MAP") && element.repetition_type !== "REPEATED" && path.length < DATA_MAX_DEPTH;
    if (splits) for (const child of node.children) visit(child, [...path, child.element.name]);
    else columns.push({ path, type: describe(node) });
  };
  for (const child of parquetSchema(metadata).children) visit(child, [child.element.name]);
  return { columns, truncated };
}

export async function openParquet(path: string, size: number): Promise<ParquetModel> {
  return withFile(path, size, async (file) => {
    const tail = new DataView(await file.slice(Math.max(0, size - 8), size));
    const footer = size >= 12 ? tail.getUint32(0, true) : 0;
    if (footer > MAX_FOOTER_BYTES) throw new Error(ERROR_MESSAGES.archiveTooLarge(`the Parquet footer is ${Math.round(footer / (1024 * 1024))} MiB`));
    let metadata: FileMetaData;
    try {
      metadata = await parquetMetadataAsync(file);
    } catch (error) {
      throw new Error(ERROR_MESSAGES.invalidOffice("parquet"), { cause: error });
    }
    const { columns, truncated } = schemaColumns(metadata);
    return { metadata, rowCount: Number(metadata.num_rows), columns, columnsTruncated: truncated };
  });
}

export function parquetModelBytes(model: ParquetModel): number {
  return model.metadata.metadata_length * 4 + model.columns.length * 128;
}

const UNSUPPORTED_CODECS = new Set(["LZO"]);

export type ReadDecision =
  | { ok: true }
  | { ok: false; reason: "codec"; codec: string }
  | { ok: false; reason: "memory"; group: number; bytes: number };

// Decides from the footer alone whether reading rows [rowStart, rowEnd) of the given top-level columns fits
// the memory budget and every codec has a decoder. Nothing is read or decoded.
export function readDecision(metadata: FileMetaData, roots: ReadonlySet<string>, rowStart: number, rowEnd: number, budget = PARQUET_MAX_READ_BYTES): ReadDecision {
  let start = 0;
  for (const [index, group] of metadata.row_groups.entries()) {
    const end = start + Number(group.num_rows);
    if (end > rowStart && start < rowEnd) {
      let bytes = 0;
      for (const chunk of group.columns) {
        const meta = chunk.meta_data;
        if (!meta || !roots.has(meta.path_in_schema[0]!)) continue;
        if (UNSUPPORTED_CODECS.has(meta.codec)) return { ok: false, reason: "codec", codec: meta.codec };
        bytes += chunk.offset_index_offset ? Number(meta.total_compressed_size) : Number(meta.total_compressed_size) + Number(meta.total_uncompressed_size);
      }
      if (bytes > budget) return { ok: false, reason: "memory", group: index, bytes };
    }
    start = end;
    if (start >= rowEnd) break;
  }
  return { ok: true };
}

const mebibytes = (bytes: number) => Math.ceil(bytes / (1024 * 1024));

// Refuses a read that would hold more than PARQUET_MAX_READ_BYTES, or that needs a codec without a decoder,
// before any byte is read: a plugin process that runs out of memory is not restarted.
export function checkRead(model: ParquetModel, roots: ReadonlySet<string>, rowStart: number, rowEnd: number): void {
  const decision = readDecision(model.metadata, roots, rowStart, rowEnd);
  if (decision.ok) return;
  if (decision.reason === "codec") throw new Error(ERROR_MESSAGES.unsupportedImage(`Parquet ${decision.codec} compression`));
  const groups = model.metadata.row_groups.length;
  const where = groups === 1 ? "its only row group" : `row group ${decision.group + 1} of ${groups}`;
  throw new Error(ERROR_MESSAGES.archiveTooLarge(
    `reading ${where} needs about ${mebibytes(decision.bytes)} MiB of memory and the viewer reads at most ${mebibytes(PARQUET_MAX_READ_BYTES)} MiB at once. Write it with smaller row groups (for example pyarrow row_group_size=100_000)`,
  ));
}

async function readRecords(path: string, size: number, model: ParquetModel, columns: readonly KeyPath[], rowStart: number, rowEnd: number): Promise<Record<string, unknown>[]> {
  const roots = new Set(columns.map((column) => column[0]!));
  if (roots.size === 0 || rowStart >= rowEnd) return [];
  checkRead(model, roots, rowStart, rowEnd);
  return withFile(path, size, async (file) => {
    let rows: Record<string, unknown>[] = [];
    try {
      await parquetRead({
        file,
        metadata: model.metadata,
        columns: [...roots],
        rowStart,
        rowEnd,
        rowFormat: "object",
        compressors,
        useOffsetIndex: true,
        // Byte arrays without a STRING annotation are binary, not text.
        utf8: false,
        onComplete: (read) => {
          rows = read;
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/codec|compression/i.test(message)) throw new Error(ERROR_MESSAGES.unsupportedImage(`This Parquet compression (${message})`));
      throw new Error(ERROR_MESSAGES.invalidOffice("parquet"), { cause: error });
    }
    return rows;
  });
}

export async function parquetWindow(
  path: string,
  size: number,
  model: ParquetModel,
  rowOffset: number,
  columnOffset: number,
  maxColumns = XLSX_MAX_COLUMNS,
  maxRows = XLSX_MAX_ROWS,
  detail = false,
): Promise<RowWindow & { columnNames: string[] }> {
  const { rowCount } = model;
  const columnCount = model.columns.length;
  const rowEnd = Math.min(rowCount, rowOffset + maxRows);
  const columnEnd = Math.min(columnCount, columnOffset + maxColumns);
  const shown = model.columns.slice(columnOffset, columnEnd);
  const paths = shown.map((column) => column.path);
  const types = new Map(shown.map((column) => [columnName(column.path), column.type]));
  const records = await readRecords(path, size, model, paths, rowOffset, rowEnd);
  const rows: string[][] = [];
  const details: (CellDetail | null)[][] = [];
  let bytes = 0;
  for (const value of records) {
    const { cells, details: rowDetails } = recordCells({ value }, paths, detail, { type: "parquet", columnType: (column) => types.get(columnName(column)) });
    const rowBytes = Buffer.byteLength(JSON.stringify(cells), "utf8") + (detail ? Buffer.byteLength(JSON.stringify(rowDetails), "utf8") : 0) + 2;
    if (rows.length > 0 && bytes + rowBytes > ROWS_BUDGET_BYTES) break;
    rows.push(cells);
    if (detail) details.push(rowDetails);
    bytes += rowBytes;
  }
  const next = rowOffset + rows.length;
  return {
    rowCount,
    columnCount,
    countsApproximate: false,
    rows,
    ...(detail ? { details } : {}),
    columnNames: paths.map(columnName),
    nextRowOffset: next < rowCount ? next : null,
    nextColumnOffset: columnEnd < columnCount ? columnEnd : null,
  };
}

export async function parquetFullValue(path: string, size: number, model: ParquetModel, row: number, column: number | null): Promise<FullValue> {
  if (row >= model.rowCount) throw new Error(ERROR_MESSAGES.outOfRange("Row", row, model.rowCount));
  if (column !== null && column >= model.columns.length) throw new Error(ERROR_MESSAGES.outOfRange("Column", column, model.columns.length));
  const paths = column === null ? model.columns.map((entry) => entry.path) : [model.columns[column]!.path];
  const [record] = await readRecords(path, size, model, paths, row, row + 1);
  if (column === null) return { ...boundedJson(record ?? {}, CELL_FULL_MAX_CHARS, 2), format: "json" };
  let value: unknown = record;
  for (const key of model.columns[column]!.path) value = isRecord(value) ? value[key] : undefined;
  return fullValue(value);
}

// Decodes the given top-level columns of rows [rowStart, rowEnd) as column arrays, without building row objects.
async function readColumns(path: string, size: number, model: ParquetModel, roots: readonly string[], rowStart: number, rowEnd: number): Promise<Map<string, unknown[]>> {
  checkRead(model, new Set(roots), rowStart, rowEnd);
  const columns = new Map(roots.map((root) => [root, new Array<unknown>(rowEnd - rowStart)]));
  await withFile(path, size, async (file) => {
    try {
      await parquetRead({
        file,
        metadata: model.metadata,
        columns: [...roots],
        rowStart,
        rowEnd,
        compressors,
        useOffsetIndex: true,
        utf8: false,
        // Chunks may start before rowStart or end after rowEnd; only the rows in range are kept.
        onChunk: ({ columnName: root, columnData, rowStart: chunkStart }) => {
          const target = columns.get(root);
          if (!target) return;
          const from = Math.max(rowStart, chunkStart);
          const to = Math.min(rowEnd, chunkStart + columnData.length);
          for (let row = from; row < to; row++) target[row - rowStart] = columnData[row - chunkStart];
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/codec|compression/i.test(message)) throw new Error(ERROR_MESSAGES.unsupportedImage(`This Parquet compression (${message})`));
      throw new Error(ERROR_MESSAGES.invalidOffice("parquet"), { cause: error });
    }
  });
  return columns;
}

// Visits rows from `fromRow` one row group at a time. Each group is decoded once as column arrays (a group
// larger than the read budget is refused by checkRead), and rows are assembled one at a time, so a search
// never re-decodes a large row group for every batch of rows. `pause` runs every SEARCH_BATCH_ROWS rows.
export async function parquetRecords(
  path: string,
  size: number,
  model: ParquetModel,
  fromRow: number,
  visit: (row: number, record: Record<string, unknown>) => boolean,
  pause: () => Promise<void> = async () => {},
): Promise<void> {
  const roots = [...new Set(model.columns.map((column) => column.path[0]!))];
  let groupStart = 0;
  for (const group of model.metadata.row_groups) {
    const groupEnd = groupStart + Number(group.num_rows);
    if (groupEnd > fromRow) {
      const start = Math.max(fromRow, groupStart);
      await pause();
      const columns = await readColumns(path, size, model, roots, start, groupEnd);
      for (let row = start; row < groupEnd; row++) {
        if (row > start && (row - start) % SEARCH_BATCH_ROWS === 0) await pause();
        const record: Record<string, unknown> = {};
        for (const [root, values] of columns) record[root] = values[row - start];
        if (!visit(row, record)) return;
      }
    }
    groupStart = groupEnd;
  }
}
