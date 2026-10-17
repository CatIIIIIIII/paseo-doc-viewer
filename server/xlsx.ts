import { posix } from "node:path";
import { StringDecoder } from "node:string_decoder";
import SSF from "ssf";
import { MAX_RESPONSE_BYTES, XLSX_MAX_CELL_CHARS, XLSX_MAX_COLUMNS, XLSX_MAX_ROWS } from "../shared/limits";
import { ERROR_MESSAGES } from "../shared/errors";
import { decodeEntities } from "./html";
import { readText, streamEntry, type ZipIndex } from "./zip";

export const XLSX_MAX_LISTED_SHEETS = 500;

export interface SheetRef {
  name: string;
  part: string | null;
  rowCount: number;
  columnCount: number;
  countsApproximate: boolean;
}

export interface Workbook {
  index: ZipIndex;
  sheets: SheetRef[];
  sheetsTruncated: boolean;
  date1904: boolean;
  dateStyles: Set<number>;
  numberFormats: Map<number, string | number>;
  sharedStringsPart: string | null;
}

export interface RowWindow {
  rowCount: number;
  columnCount: number;
  countsApproximate: boolean;
  rows: string[][];
  nextRowOffset: number | null;
  nextColumnOffset: number | null;
}

const ROWS_BUDGET_BYTES = MAX_RESPONSE_BYTES - 64 * 1024;
const MAX_PENDING_CHARS = 4 * 1024 * 1024;
const DIMENSION_SCAN_CHARS = 64 * 1024;
const WINDOW_DEADLINE_MS = 20_000;
const BUILTIN_DATE_FORMATS = new Set([14, 15, 16, 17, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 50, 51, 52, 53, 54, 55, 56, 57, 58]);
const BUILTIN_NUMBER_FORMATS = new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 18, 19, 20, 21, 22, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48]);
const SHEET = /<sheet\b[^>]*>/g;
const RELATIONSHIP = /<Relationship\b[^>]*>/g;
const SHEET_TOKEN = /<row\b[^>]*?(\/?)>|<\/row>|<c\b[^>]*?\/>|<c\b[^>]*>[\s\S]*?<\/c>|<\/sheetData>/g;
const SHARED_STRING = /<si\b[^>]*>[\s\S]*?<\/si>|<si\s*\/>/g;
const TEXT_RUN = /<t\b[^>]*>([^<]*)<\/t>/g;
const PHONETIC = /<rPh\b[\s\S]*?<\/rPh>/g;

const attribute = (tag: string, name: string) => {
  const value = new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1];
  return value === undefined ? undefined : decodeEntities(value);
};
const clip = (text: string) => (text.length > XLSX_MAX_CELL_CHARS ? text.slice(0, XLSX_MAX_CELL_CHARS) : text);

async function* scan(chunks: AsyncIterable<Buffer>, token: RegExp): AsyncGenerator<RegExpExecArray> {
  const decoder = new StringDecoder("utf8");
  let pending = "";
  for await (const chunk of chunks) {
    pending += decoder.write(chunk);
    token.lastIndex = 0;
    let end = -1;
    for (let match = token.exec(pending); match; match = token.exec(pending)) {
      end = token.lastIndex;
      yield match;
    }
    if (end >= 0) pending = pending.slice(end);
    else {
      const resume = Math.max(pending.lastIndexOf("<c"), pending.lastIndexOf("<row"), pending.lastIndexOf("</"), pending.lastIndexOf("<si"));
      pending = resume >= 0 ? pending.slice(resume) : "";
    }
    if (pending.length > MAX_PENDING_CHARS) throw new Error(ERROR_MESSAGES.archiveTooLarge("a single cell is larger than 4 MiB"));
  }
}

const TOKEN_START = /<(?:c|row|si)[\s>/]|<\/sheetData/g;

function resumePoint(pending: string): number {
  let start = -1;
  for (const match of pending.matchAll(TOKEN_START)) start = match.index;
  if (start >= 0) return start;
  const tail = pending.lastIndexOf("<");
  return tail >= 0 && !pending.includes(">", tail) ? tail : pending.length;
}

function columnIndex(reference: string): number {
  let column = 0;
  for (const char of reference) {
    const code = char.charCodeAt(0);
    if (code < 65 || code > 90) break;
    column = column * 26 + (code - 64);
  }
  return column - 1;
}

const unquoted = (code: string) => code.replace(/"[^"]*"/g, "").replace(/\\./g, "");

function isDateFormat(code: string): boolean {
  const stripped = unquoted(code).replace(/\[[^\]]*\]/g, "");
  return /[dmyhs]/i.test(stripped) && !/^general$/i.test(stripped.trim());
}

function hasTime(code: string): boolean {
  const text = unquoted(code);
  return /\[(?:h+|m+|s+)\]/i.test(text) || /[hs]/i.test(text.replace(/\[[^\]]*\]/g, ""));
}

const MAX_FORMAT_CODE_CHARS = 255;
const isGeneral = (code: string) => code.length > MAX_FORMAT_CODE_CHARS || /^(general|@)?$/i.test(code.trim());

function cellFormats(styles: string | null): Pick<Workbook, "dateStyles" | "numberFormats"> {
  const result = { dateStyles: new Set<number>(), numberFormats: new Map<number, string | number>() };
  if (!styles) return result;
  const custom = new Map<number, string>();
  for (const [tag] of styles.matchAll(/<numFmt\b[^>]*>/g)) {
    custom.set(Number(attribute(tag, "numFmtId")), attribute(tag, "formatCode") ?? "");
  }
  const cellXfs = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(styles)?.[1] ?? "";
  let index = 0;
  for (const [tag] of cellXfs.matchAll(/<xf\b[^>]*>/g)) {
    const id = Number(attribute(tag, "numFmtId") ?? 0);
    const code = custom.get(id);
    if (code === undefined) {
      if (BUILTIN_DATE_FORMATS.has(id)) result.dateStyles.add(index);
      else if (BUILTIN_NUMBER_FORMATS.has(id)) result.numberFormats.set(index, id);
    } else if (isDateFormat(code) && !hasTime(code)) result.dateStyles.add(index);
    else if (!isGeneral(code)) result.numberFormats.set(index, code);
    index++;
  }
  return result;
}

async function relationships(index: ZipIndex, part: string): Promise<Map<string, { target: string; type: string }>> {
  const rels = posix.join(posix.dirname(part), "_rels", `${posix.basename(part)}.rels`);
  const xml = (await readText(index, rels, "xlsx")) ?? "";
  const targets = new Map<string, { target: string; type: string }>();
  for (const [tag] of xml.matchAll(RELATIONSHIP)) {
    const id = attribute(tag, "Id");
    const target = attribute(tag, "Target");
    if (!id || !target || attribute(tag, "TargetMode") === "External") continue;
    const resolved = target.startsWith("/") ? target.slice(1) : posix.normalize(posix.join(posix.dirname(part), target));
    targets.set(id, { target: resolved, type: attribute(tag, "Type") ?? "" });
  }
  return targets;
}

function parseRange(reference: string): { rows: number; columns: number } | null {
  const last = reference.split(":").pop() ?? "";
  const match = /^\$?([A-Z]+)\$?(\d+)$/.exec(last);
  if (!match) return null;
  return { rows: Number(match[2]), columns: columnIndex(match[1]) + 1 };
}

async function sheetDimension(index: ZipIndex, part: string): Promise<{ rows: number; columns: number } | null> {
  const decoder = new StringDecoder("utf8");
  let head = "";
  for await (const chunk of streamEntry(index, part, "xlsx")) {
    head += decoder.write(chunk);
    const dimension = /<dimension\b[^>]*\sref="([^"]+)"/.exec(head);
    if (dimension) return parseRange(dimension[1]);
    if (head.includes("<sheetData") || head.length > DIMENSION_SCAN_CHARS) return null;
  }
  return null;
}

export async function loadWorkbook(index: ZipIndex): Promise<Workbook> {
  const workbookPart = "xl/workbook.xml";
  const xml = await readText(index, workbookPart, "xlsx");
  if (xml === null) throw new Error(ERROR_MESSAGES.invalidOffice("xlsx"));
  const rels = await relationships(index, workbookPart);
  const declared = [...xml.matchAll(SHEET)].map(([tag]) => {
    const id = /\s[\w]+:id="([^"]+)"/.exec(tag)?.[1];
    return { name: attribute(tag, "name") ?? "", part: (id && rels.get(id)?.target) || null };
  });
  const listed = declared.slice(0, XLSX_MAX_LISTED_SHEETS);
  const sheets: SheetRef[] = [];
  for (const sheet of listed) {
    const dimension = sheet.part && index.entries.has(sheet.part) ? await sheetDimension(index, sheet.part) : null;
    sheets.push({
      name: sheet.name,
      part: sheet.part,
      rowCount: dimension?.rows ?? 0,
      columnCount: dimension?.columns ?? 0,
      countsApproximate: dimension === null,
    });
  }
  const related = [...rels.values()];
  const find = (suffix: string, fallback: string) =>
    related.find((rel) => rel.type.endsWith(suffix))?.target ?? (index.entries.has(fallback) ? fallback : null);
  const stylesPart = find("/styles", "xl/styles.xml");
  return {
    index,
    sheets,
    sheetsTruncated: declared.length > listed.length,
    date1904: /<workbookPr\b[^>]*\sdate1904="(?:1|true)"/.test(xml),
    ...cellFormats(stylesPart ? await readText(index, stylesPart, "xlsx") : null),
    sharedStringsPart: find("/sharedStrings", "xl/sharedStrings.xml"),
  };
}

export async function loadSharedStrings(workbook: Workbook): Promise<string[]> {
  const strings: string[] = [];
  if (!workbook.sharedStringsPart) return strings;
  for await (const [item] of scan(streamEntry(workbook.index, workbook.sharedStringsPart, "xlsx"), SHARED_STRING)) {
    let text = "";
    for (const run of item.replace(PHONETIC, "").matchAll(TEXT_RUN)) {
      text += run[1];
      if (text.length > XLSX_MAX_CELL_CHARS * 2) break;
    }
    strings.push(clip(decodeEntities(text)));
  }
  return strings;
}

function excelDate(serial: number, date1904: boolean): string {
  const date = new Date(Math.round((serial - (date1904 ? -1462 : 0) - 25569) * 86_400_000));
  return Number.isNaN(date.getTime()) ? "" : date.toISOString().slice(0, 10);
}

const general = (value: number) => String(Number(value.toPrecision(15)));

function formatNumber(format: string | number | undefined, value: number, date1904: boolean): string {
  if (format === undefined) return general(value);
  try {
    return SSF.format(format, value, { date1904 });
  } catch {
    return general(value);
  }
}

function cellText(cell: string, workbook: Workbook, strings: string[]): string {
  const open = /^<c\b[^>]*>/.exec(cell)![0];
  const type = attribute(open, "t");
  if (type === "inlineStr") {
    let text = "";
    for (const run of cell.replace(PHONETIC, "").matchAll(TEXT_RUN)) text += run[1];
    return clip(decodeEntities(text));
  }
  const raw = /<v\b[^>]*>([^<]*)<\/v>/.exec(cell)?.[1];
  if (raw === undefined) {
    const formula = /<f\b[^>]*>([^<]*)<\/f>/.exec(cell)?.[1];
    return formula ? clip(`=${decodeEntities(formula)}`) : "";
  }
  const value = decodeEntities(raw);
  switch (type) {
    case "s":
      return strings[Number(value)] ?? "";
    case "b":
      return value === "1" || value === "true" ? "true" : "false";
    case "d":
      return value.slice(0, 10);
    case "e":
    case "str":
      return clip(value);
    default: {
      const number = Number(value);
      if (value.trim() === "" || Number.isNaN(number)) return clip(value);
      const style = Number(attribute(open, "s") ?? 0);
      if (workbook.dateStyles.has(style)) return excelDate(number, workbook.date1904);
      return clip(formatNumber(workbook.numberFormats.get(style), number, workbook.date1904));
    }
  }
}

export interface SheetRow {
  row: number;
  cells: Map<number, string> | null;
  maxColumn: number;
}

// Yields every row in document order. Rows before `fromRow` carry no cells, so
// skipping them costs only tokenizing; cells outside the column range are not decoded.
export async function* sheetRows(
  workbook: Workbook,
  strings: string[],
  sheet: SheetRef,
  fromRow: number,
  columnStart = 0,
  columnEnd = Number.POSITIVE_INFINITY,
  deadline = Number.POSITIVE_INFINITY,
  sharedMatches?: ReadonlySet<number>,
): AsyncGenerator<SheetRow> {
  if (!sheet.part) return;
  let current: SheetRow | null = null;
  let column = -1;
  let seen = 0;
  for await (const match of scan(streamEntry(workbook.index, sheet.part, "xlsx"), SHEET_TOKEN)) {
    const token = match[0];
    if (token.startsWith("<row")) {
      if (current) yield current;
      const declared = Number(attribute(token, "r"));
      const row: number = Number.isInteger(declared) && declared > 0 ? declared - 1 : (current?.row ?? -1) + 1;
      current = { row, cells: row >= fromRow ? new Map() : null, maxColumn: -1 };
      column = -1;
      if (++seen % 4096 === 0 && Date.now() > deadline) throw new Error(ERROR_MESSAGES.slowWindow());
      continue;
    }
    if (token === "</sheetData>") break;
    if (token === "</row>") continue;
    const reference = attribute(/^<c\b[^>]*>/.exec(token)?.[0] ?? token, "r");
    column = reference ? columnIndex(reference) : column + 1;
    if (!current?.cells) continue;
    current.maxColumn = Math.max(current.maxColumn, column);
    if (column < columnStart || column >= columnEnd || (sharedMatches && !keepsSharedString(token, sharedMatches))) continue;
    current.cells.set(column, cellText(token, workbook, strings));
  }
  if (current) yield current;
}

// Search passes the indices of matching shared strings, so other shared-string cells are skipped undecoded.
function keepsSharedString(cell: string, matches: ReadonlySet<number>): boolean {
  if (attribute(/^<c\b[^>]*>/.exec(cell)?.[0] ?? cell, "t") !== "s") return true;
  return matches.has(Number(/<v\b[^>]*>([^<]*)<\/v>/.exec(cell)?.[1]));
}

export async function rowWindow(
  workbook: Workbook,
  strings: string[],
  sheet: SheetRef,
  rowOffset: number,
  columnOffset: number,
  maxColumns = XLSX_MAX_COLUMNS,
  maxRows = XLSX_MAX_ROWS,
): Promise<RowWindow> {
  const rowEnd = rowOffset + maxRows;
  const present = new Map<number, Map<number, string>>();
  let lastRow = -1;
  let maxColumn = -1;
  let beyond = -1;
  const deadline = Date.now() + WINDOW_DEADLINE_MS;
  for await (const { row, cells, maxColumn: rowColumns } of sheetRows(workbook, strings, sheet, rowOffset, columnOffset, columnOffset + maxColumns, deadline)) {
    if (row >= rowEnd) {
      beyond = row;
      break;
    }
    lastRow = Math.max(lastRow, row);
    if (!cells) continue;
    present.set(row, cells);
    maxColumn = Math.max(maxColumn, rowColumns);
  }
  const rowCount = Math.max(sheet.rowCount, lastRow + 1, beyond + 1);
  const columnCount = Math.max(sheet.columnCount, maxColumn + 1);
  const columnEnd = Math.min(columnCount, columnOffset + maxColumns);
  const rowLimit = Math.min(rowCount, rowEnd);
  const rows: string[][] = [];
  let bytes = 0;
  let next = rowOffset;
  for (; next < rowLimit; next++) {
    const cells = present.get(next);
    const row: string[] = [];
    for (let c = columnOffset; c < columnEnd; c++) row.push(cells?.get(c) ?? "");
    const rowBytes = Buffer.byteLength(JSON.stringify(row), "utf8") + 1;
    if (rows.length > 0 && bytes + rowBytes > ROWS_BUDGET_BYTES) break;
    rows.push(row);
    bytes += rowBytes;
  }
  return {
    rowCount,
    columnCount,
    countsApproximate: sheet.countsApproximate,
    rows,
    nextRowOffset: next < rowCount ? next : null,
    nextColumnOffset: columnEnd < columnCount ? columnEnd : null,
  };
}
