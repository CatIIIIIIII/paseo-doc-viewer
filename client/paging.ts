import { MAX_RENDER_EDGE_PX, XLSX_MAX_COLUMNS } from "../shared/limits";
import { errorCode } from "../shared/errors";
import { formatCount } from "./format";

export function clampIndex(index: number, count: number): number {
  if (count <= 0) return 0;
  return Math.min(Math.max(0, Math.floor(index)), count - 1);
}

export function pageRequests(index: number, count: number): { current: number | null; prefetch: number | null } {
  if (count <= 0) return { current: null, prefetch: null };
  const current = clampIndex(index, count);
  return { current, prefetch: current + 1 < count ? current + 1 : null };
}

const MAX_PAGE_RETRIES = 3;

export function isTransient(error: unknown): boolean {
  const code = errorCode(error);
  return code === null || code === "timeout";
}

export function retryPage(failureCount: number, error: unknown): boolean {
  return isTransient(error) && failureCount < MAX_PAGE_RETRIES;
}

export function canRetry(error: unknown): boolean {
  return isTransient(error) || errorCode(error) === "stopped";
}

export type StripItem = { type: "page"; index: number } | { type: "gap"; after: number };

export function stripItems(current: number, count: number, radius = 3): StripItem[] {
  if (count <= 0) return [];
  const active = clampIndex(current, count);
  const shown = new Set<number>([0, count - 1]);
  for (let index = active - radius; index <= active + radius; index++) {
    if (index >= 0 && index < count) shown.add(index);
  }
  const sorted = [...shown].sort((a, b) => a - b);
  const items: StripItem[] = [];
  sorted.forEach((index, position) => {
    const previous = sorted[position - 1];
    if (previous !== undefined && index - previous === 2) items.push({ type: "page", index: previous + 1 });
    else if (previous !== undefined && index - previous > 2) items.push({ type: "gap", after: previous });
    items.push({ type: "page", index });
  });
  return items;
}

const RENDER_WIDTH_STEP_PX = 256;

export function renderWidthFor(layoutWidth: number, pixelRatio: number, zoom = 1): number | null {
  if (!(layoutWidth > 0)) return null;
  const physical = layoutWidth * zoom * Math.max(1, pixelRatio);
  const stepped = Math.ceil(physical / RENDER_WIDTH_STEP_PX) * RENDER_WIDTH_STEP_PX;
  return Math.min(MAX_RENDER_EDGE_PX, stepped);
}

export const ZOOM_STEPS = [1, 1.5, 2, 3] as const;

const MIN_ZOOM = ZOOM_STEPS[0];
const MAX_ZOOM = ZOOM_STEPS[ZOOM_STEPS.length - 1];

export function clampZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) return MIN_ZOOM;
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round(zoom * 10) / 10));
}

export function zoomLabel(zoom: number): string {
  const rounded = clampZoom(zoom);
  return rounded === MIN_ZOOM ? "Fit" : `${rounded}x`;
}

export function nextZoomStep(zoom: number): number {
  return ZOOM_STEPS.find((step) => step > clampZoom(zoom)) ?? MAX_ZOOM;
}

export function previousZoomStep(zoom: number): number {
  return [...ZOOM_STEPS].reverse().find((step) => step < clampZoom(zoom)) ?? MIN_ZOOM;
}

export function tapZoom(zoom: number): number {
  return clampZoom(zoom) > MIN_ZOOM ? MIN_ZOOM : 2;
}

export function pinchScale(startDistance: number, distance: number, zoom: number): number {
  if (!(startDistance > 0)) return 1;
  return Math.min(MAX_ZOOM / zoom, Math.max(MIN_ZOOM / zoom, distance / startDistance));
}

export function scaleShift(focal: number, center: number, scale: number): number {
  return (focal - center) * (1 - scale) + 0;
}

export function focalOffset(offset: number, focal: number, ratio: number): number {
  return Math.max(0, (offset + focal) * ratio - focal);
}

export function clampOffset(offset: number, content: number, viewport: number): number {
  return Math.min(Math.max(0, offset), Math.max(0, content - viewport));
}

export function fitSize(
  containerWidth: number,
  image: { width: number; height: number },
): { width: number; height: number } {
  if (!(containerWidth > 0) || image.width <= 0) return { width: 0, height: 0 };
  return { width: containerWidth, height: Math.round((containerWidth * image.height) / image.width) };
}

const MIN_SHEET_COLUMNS = 8;
const SHEET_COLUMN_SCREENS = 2;
const SHEET_ROW_SCREENS = 3;
const MAX_MOUNTED_CELLS = 3000;

export interface SheetWindow {
  columns: number;
  rowsPerScreen: number;
  windowSize: number;
}

export function sheetWindow(
  viewport: { width: number; height: number },
  cell: { width: number; height: number },
): SheetWindow {
  const columnsPerScreen = Math.max(1, Math.ceil(viewport.width / cell.width));
  const rowsPerScreen = Math.max(1, Math.ceil(viewport.height / cell.height));
  const budget = Math.floor(MAX_MOUNTED_CELLS / (rowsPerScreen * SHEET_ROW_SCREENS));
  const columns = Math.min(XLSX_MAX_COLUMNS, budget, columnsPerScreen * SHEET_COLUMN_SCREENS);
  return { columns: Math.max(MIN_SHEET_COLUMNS, columns), rowsPerScreen, windowSize: SHEET_ROW_SCREENS };
}

export interface GridState {
  sheet: number;
  rowOffset: number;
  columnOffset: number;
  rowHistory: readonly number[];
  columnHistory: readonly number[];
}

export type GridAction =
  | { type: "sheet"; sheet: number }
  | { type: "nextRows"; offset: number | null }
  | { type: "prevRows" }
  | { type: "nextColumns"; offset: number | null }
  | { type: "prevColumns" }
  | { type: "reconcile"; state: GridState };

export const INITIAL_GRID: GridState = { sheet: 0, rowOffset: 0, columnOffset: 0, rowHistory: [], columnHistory: [] };

export function gridReducer(state: GridState, action: GridAction): GridState {
  switch (action.type) {
    case "reconcile":
      return action.state;
    case "sheet":
      return action.sheet === state.sheet ? state : { ...INITIAL_GRID, sheet: action.sheet };
    case "nextRows":
      if (action.offset === null || action.offset <= state.rowOffset) return state;
      return { ...state, rowOffset: action.offset, rowHistory: [...state.rowHistory, state.rowOffset] };
    case "prevRows": {
      if (state.rowHistory.length === 0) return state;
      return { ...state, rowOffset: state.rowHistory[state.rowHistory.length - 1]!, rowHistory: state.rowHistory.slice(0, -1) };
    }
    case "nextColumns":
      if (action.offset === null || action.offset <= state.columnOffset) return state;
      return { ...state, columnOffset: action.offset, columnHistory: [...state.columnHistory, state.columnOffset] };
    case "prevColumns": {
      if (state.columnHistory.length === 0) return state;
      return {
        ...state,
        columnOffset: state.columnHistory[state.columnHistory.length - 1]!,
        columnHistory: state.columnHistory.slice(0, -1),
      };
    }
  }
}

export function reconcileGrid(
  state: GridState,
  sheets: readonly { rowCount: number; columnCount: number; countsApproximate?: boolean }[],
): GridState {
  if (sheets.length === 0) return state.sheet === 0 && state.rowOffset === 0 && state.columnOffset === 0 ? state : INITIAL_GRID;
  const sheet = clampIndex(state.sheet, sheets.length);
  if (sheet !== state.sheet) return { ...INITIAL_GRID, sheet };
  const { rowCount, columnCount, countsApproximate } = sheets[sheet]!;
  if (countsApproximate) return state;
  const rowsGone = state.rowOffset > 0 && state.rowOffset >= rowCount;
  const columnsGone = state.columnOffset > 0 && state.columnOffset >= columnCount;
  if (!rowsGone && !columnsGone) return state;
  return {
    ...state,
    ...(rowsGone ? { rowOffset: 0, rowHistory: [] } : {}),
    ...(columnsGone ? { columnOffset: 0, columnHistory: [] } : {}),
  };
}

export function rangeLabel(
  noun: string,
  offset: number,
  shown: number,
  total: number,
  { approximate = false, more = false }: { approximate?: boolean; more?: boolean } = {},
): string {
  if ((total === 0 && !approximate) || shown === 0) return `No ${noun}`;
  const range = `${noun[0]!.toUpperCase()}${noun.slice(1)} ${formatCount(offset + 1)}-`;
  if (approximate && more) return `${range}${formatCount(offset + shown)}`;
  const last = Math.min(total, offset + shown);
  return `${range}${formatCount(last)} of ${approximate ? "about " : ""}${formatCount(total)}`;
}

export function columnName(index: number): string {
  let name = "";
  let remaining = index + 1;
  while (remaining > 0) {
    const digit = (remaining - 1) % 26;
    name = String.fromCharCode(65 + digit) + name;
    remaining = Math.floor((remaining - 1) / 26);
  }
  return name;
}

export function omittedImagesNote(count: number, reasons: readonly string[] = []): string | null {
  if (count <= 0) return null;
  const subject = count === 1 ? "1 image is" : `${count} images are`;
  const distinct = [...new Set(reasons.filter((reason) => reason.trim() !== ""))];
  return distinct.length ? `${subject} not shown: ${distinct.join(", ")}` : `${subject} not shown`;
}

export function pageTextNote({ text, truncated }: { text: string; truncated: boolean }): string | null {
  if (text.trim() === "") return "This page has no selectable text. It may be a scan or outlined text.";
  return truncated ? "Text is cut short: this page has more text than the viewer shows." : null;
}
