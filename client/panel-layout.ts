export const DETAILS_FOLDER_MIN_WIDTH = 640;
const DETAILS_SIZE_MIN_WIDTH = 400;

export interface DetailsColumns {
  folder: "column" | "inline";
  size: boolean;
  time: "long" | "short";
  timeWidth: number;
  statusWidth: number;
  rowHeight: number;
  iconSize: number;
  nameSize: number;
}

export function detailsColumns(width: number, compact: boolean): DetailsColumns {
  if (compact) return { folder: "inline", size: false, time: "short", timeWidth: 80, statusWidth: 92, rowHeight: 44, iconSize: 16, nameSize: 14 };
  const wide = width >= DETAILS_FOLDER_MIN_WIDTH;
  return {
    folder: wide ? "column" : "inline",
    size: width >= DETAILS_SIZE_MIN_WIDTH,
    time: wide ? "long" : "short",
    timeWidth: wide ? 112 : 80,
    statusWidth: 92,
    rowHeight: 28,
    iconSize: 14,
    nameSize: 13,
  };
}

export const PREVIEWS_MIN_WIDTH = 240;
const LIST_PADDING = 8;
const PREVIEW_CELL = 140;
export const PREVIEW_CAPTION_HEIGHT = 44;
const MAX_PIXEL_RATIO = 2;

export interface PreviewGrid {
  columns: number;
  gap: number;
  cellWidth: number;
  frameSize: number;
  requestWidth: 160 | 240;
}

export function previewGrid(width: number, compact: boolean, pixelRatio: number): PreviewGrid | null {
  if (!compact && width < PREVIEWS_MIN_WIDTH) return null;
  const usable = Math.max(0, width - 2 * LIST_PADDING);
  const gap = compact ? 8 : 12;
  const columns = compact ? (usable >= 420 ? 3 : 2) : Math.max(2, Math.round((usable + gap) / (PREVIEW_CELL + gap)));
  const cellWidth = Math.max(1, Math.floor((usable - gap * (columns - 1)) / columns));
  const requestWidth = cellWidth * Math.min(pixelRatio, MAX_PIXEL_RATIO) <= 160 ? 160 : 240;
  return { columns, gap, cellWidth, frameSize: cellWidth, requestWidth };
}
