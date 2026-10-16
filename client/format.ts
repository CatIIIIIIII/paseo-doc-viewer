import { errorCode, errorText, type ErrorCode } from "../shared/errors";
import type { DocumentGroup } from "../shared/browse";
import type { DocumentKind } from "../shared/kinds";

export function baseName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

export function parentDir(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.slice(0, -1).join("/");
}

const UNITS = ["B", "KB", "MB", "GB"];

export function humanSize(bytes: number): string {
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const rounded = unit > 0 && value < 10 ? value.toFixed(1) : String(Math.round(value));
  return `${rounded} ${UNITS[unit]}`;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export function relativeTime(mtimeMs: number, nowMs: number): string {
  const elapsed = Math.max(0, nowMs - mtimeMs);
  if (elapsed < MINUTE) return "just now";
  if (elapsed < HOUR) return `${Math.floor(elapsed / MINUTE)} min ago`;
  if (elapsed < DAY) return `${Math.floor(elapsed / HOUR)} h ago`;
  const days = Math.floor(elapsed / DAY);
  if (days < 30) return days === 1 ? "yesterday" : `${days} days ago`;
  return new Date(mtimeMs).toISOString().slice(0, 10);
}

export function formatCount(value: number): string {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

export const KIND_ICON: { readonly [K in DocumentKind]: string } = {
  pdf: "FileText",
  docx: "FileType",
  xlsx: "FileSpreadsheet",
  csv: "FileSpreadsheet",
  pptx: "Presentation",
  video: "FileVideoCamera",
  "image-raster": "FileImage",
  "image-decoded": "FileImage",
};

export const KIND_LABEL: { readonly [K in DocumentKind]: string } = {
  pdf: "PDF",
  docx: "Word document",
  xlsx: "Spreadsheet",
  csv: "CSV table",
  pptx: "Presentation",
  video: "Video",
  "image-raster": "Image",
  "image-decoded": "Image",
};

export const GROUP_LABEL: { readonly [G in DocumentGroup]: string } = {
  pdf: "PDF",
  word: "Word",
  excel: "Spreadsheets",
  powerpoint: "PowerPoint",
  image: "Images",
  video: "Video",
};

export const GROUP_FILES: { readonly [G in DocumentGroup]: string } = {
  pdf: "PDF files",
  word: "Word files",
  excel: "spreadsheets",
  powerpoint: "PowerPoint files",
  image: "images",
  video: "Video files",
};

export interface ErrorState {
  icon: string;
  title: string;
  detail: string;
}

const ERROR_STATES: { readonly [C in ErrorCode]: { icon: string; title: string; detail?: string } } = {
  password_required: { icon: "Lock", title: "This PDF is password protected", detail: "Enter its password to open it" },
  password_incorrect: { icon: "Lock", title: "Incorrect password" },
  unsupported_encryption: { icon: "Lock", title: "This file is encrypted" },
  encrypted_office: { icon: "Lock", title: "This file is password protected", detail: "Remove the password in Office to preview it here" },
  legacy_format: { icon: "FileX", title: "Legacy Office format", detail: "Save it as .docx, .xlsx, or .pptx to preview it here" },
  unsupported_format: { icon: "FileX", title: "Unsupported file" },
  too_large: { icon: "TriangleAlert", title: "Too large to preview" },
  outside_workspace: { icon: "TriangleAlert", title: "Outside the workspace", detail: "Only files inside the workspace can be opened" },
  not_found: { icon: "FileX", title: "File not found", detail: "It may have been moved or deleted" },
  workspace_not_found: { icon: "TriangleAlert", title: "Workspace not found", detail: "The workspace may have been closed or removed" },
  damaged: { icon: "FileX", title: "The file looks damaged" },
  out_of_range: { icon: "TriangleAlert", title: "Nothing to show here" },
  timeout: { icon: "TriangleAlert", title: "The host took too long to respond" },
  invalid_request: { icon: "TriangleAlert", title: "Unable to open document" },
  stopped: { icon: "PowerOff", title: "The document viewer stopped", detail: "Reload the plugin or restart Paseo" },
};

export function describeError(error: unknown): ErrorState {
  const code = errorCode(error);
  const detail = errorText(error) || "Unknown error";
  if (!code) return { icon: "TriangleAlert", title: "Unable to open document", detail };
  const state = ERROR_STATES[code];
  return { icon: state.icon, title: state.title, detail: state.detail ?? detail };
}
