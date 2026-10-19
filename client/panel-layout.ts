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
  if (compact) return { folder: "inline", size: false, time: "short", timeWidth: 64, statusWidth: 92, rowHeight: 44, iconSize: 16, nameSize: 14 };
  const wide = width >= DETAILS_FOLDER_MIN_WIDTH;
  return {
    folder: wide ? "column" : "inline",
    size: width >= DETAILS_SIZE_MIN_WIDTH,
    time: wide ? "long" : "short",
    timeWidth: wide ? 112 : 64,
    statusWidth: 92,
    rowHeight: 28,
    iconSize: 14,
    nameSize: 13,
  };
}
