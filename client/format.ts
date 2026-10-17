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
  audio: "FileAudio",
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
  audio: "Audio",
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
  audio: "Audio",
};

export const GROUP_FILES: { readonly [G in DocumentGroup]: string } = {
  pdf: "PDF files",
  word: "Word files",
  excel: "spreadsheets",
  powerpoint: "PowerPoint files",
  image: "images",
  video: "Video files",
  audio: "audio files",
};

// "muted" is for files the viewer cannot or may not show; "danger" is for something that broke.
export type ErrorTone = "muted" | "danger";

export interface ErrorState {
  icon: string;
  title: string;
  detail: string;
  tone: ErrorTone;
}

const ERROR_STATES: { readonly [C in ErrorCode]: { icon: string; title: string; detail?: string; tone: ErrorTone } } = {
  password_required: { icon: "Lock", title: "This PDF is password protected", detail: "Enter its password to open it", tone: "muted" },
  password_incorrect: { icon: "Lock", title: "Incorrect password", tone: "danger" },
  unsupported_encryption: { icon: "Lock", title: "This file is encrypted", tone: "muted" },
  encrypted_office: { icon: "Lock", title: "This file is password protected", detail: "Remove the password in Office to preview it here", tone: "muted" },
  legacy_format: { icon: "FileX", title: "Legacy Office format", detail: "Save it as .docx, .xlsx, or .pptx to preview it here", tone: "muted" },
  unsupported_format: { icon: "FileX", title: "Unsupported file", tone: "muted" },
  too_large: { icon: "FileX", title: "Too large to preview", tone: "muted" },
  outside_workspace: { icon: "FileX", title: "Outside the workspace", detail: "Only files inside the workspace can be opened", tone: "muted" },
  not_found: { icon: "FileX", title: "File not found", detail: "It may have been moved or deleted", tone: "muted" },
  workspace_not_found: { icon: "FolderX", title: "Workspace not found", detail: "The workspace may have been closed or removed", tone: "muted" },
  damaged: { icon: "FileX", title: "The file looks damaged", tone: "danger" },
  out_of_range: { icon: "TriangleAlert", title: "Nothing to show here", tone: "muted" },
  timeout: { icon: "TriangleAlert", title: "The host took too long to respond", tone: "danger" },
  invalid_request: { icon: "TriangleAlert", title: "Unable to open document", tone: "danger" },
  stopped: { icon: "PowerOff", title: "The document viewer stopped", detail: "Reload the plugin or restart Paseo", tone: "danger" },
};

// Daemon messages that only restate the title get a next step instead.
const RESTATED: Readonly<Record<string, string>> = {
  "PDF is damaged or invalid": "It may be incomplete or still being written. Try again later, or open the original in another app.",
};

export function describeError(error: unknown): ErrorState {
  const code = errorCode(error);
  const detail = errorText(error) || "Unknown error";
  if (!code) return { icon: "TriangleAlert", title: "Unable to open document", detail, tone: "danger" };
  const state = ERROR_STATES[code];
  return { icon: state.icon, title: state.title, detail: state.detail ?? RESTATED[detail] ?? detail, tone: state.tone };
}

// The original can still be downloaded unless the file itself cannot be reached.
export function originalReachable(error: unknown): boolean {
  const code = errorCode(error);
  return code !== "not_found" && code !== "outside_workspace" && code !== "workspace_not_found";
}
