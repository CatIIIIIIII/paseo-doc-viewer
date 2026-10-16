export const ERROR_CODES = [
  "password_protected",
  "unsupported_encryption",
  "encrypted_office",
  "legacy_format",
  "unsupported_format",
  "too_large",
  "outside_workspace",
  "not_found",
  "workspace_not_found",
  "damaged",
  "out_of_range",
  "timeout",
  "invalid_request",
  "stopped",
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

const TAG = /\[doc:([a-z_]+)\]\s?/;
const HOST_PREFIX = /^Request failed: /;
const HOST_SUFFIX = / requestType=\S+(?: code=\S+)?$/;
const HOST_TIMEOUT = /^(?:Request failed: )?(?:Plugin RPC timed out|Timeout waiting for message)/;
const HOST_STOPPED = /^(?:Request failed: )?Plugin (?:process exited|is not available|stopped): /;

const tagged = (code: ErrorCode, text: string) => `[doc:${code}] ${text}`;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : typeof error === "string" ? error : "";
}

export function errorCode(error: unknown): ErrorCode | null {
  const message = messageOf(error);
  const code = TAG.exec(message)?.[1];
  if (code && (ERROR_CODES as readonly string[]).includes(code)) return code as ErrorCode;
  if (HOST_TIMEOUT.test(message)) return "timeout";
  return HOST_STOPPED.test(message) ? "stopped" : null;
}

export function errorText(error: unknown): string {
  const message = messageOf(error).replace(HOST_PREFIX, "").replace(HOST_SUFFIX, "");
  const match = TAG.exec(message);
  return match ? message.slice(match.index + match[0].length) : message;
}

export const ERROR_MESSAGES = {
  outsideWorkspace: () => tagged("outside_workspace", "Path is outside the workspace"),
  invalidPath: () => tagged("invalid_request", "Invalid path"),
  fileNotFound: (path: string) => tagged("not_found", `File not found: ${path}`),
  notAFile: (path: string) => tagged("invalid_request", `Not a file: ${path}`),
  workspaceNotFound: (workspaceId: string) => tagged("workspace_not_found", `Workspace not found: ${workspaceId}`),
  workspaceWithoutDirectory: (workspaceId: string) =>
    tagged("workspace_not_found", `Workspace ${workspaceId} has no directory on disk`),
  unsupportedType: (extension: string) => tagged("unsupported_format", `Unsupported file type: .${extension}`),
  legacyOffice: () =>
    tagged("legacy_format", "Legacy Office format (.doc, .xls, .ppt) is not supported; re-save it as .docx, .xlsx, or .pptx"),
  encryptedOffice: () => tagged("encrypted_office", "This Office file is encrypted; remove the password to preview it"),
  contentMismatch: (extension: string) => tagged("damaged", `File content does not match its .${extension} extension`),
  pdfEncrypted: () => tagged("password_protected", "PDF is encrypted and needs a password"),
  pdfCertificateSecurity: () =>
    tagged("unsupported_encryption", "PDF is protected with certificate security, which cannot be opened here"),
  pdfUnsupportedSecurity: () => tagged("unsupported_encryption", "PDF is encrypted with an unsupported security scheme"),
  pdfDamaged: () => tagged("damaged", "PDF is damaged or invalid"),
  invalidOffice: (extension: string) => tagged("damaged", `File is not a valid .${extension} file`),
  fileTooLarge: (size: number, limit: number) =>
    tagged("too_large", `File is too large to preview (${mib(size)}; the limit is ${mib(limit)})`),
  archiveTooLarge: (detail: string) => tagged("too_large", `Document is too large to preview: ${detail}`),
  outOfRange: (noun: string, index: number, count: number) =>
    tagged("out_of_range", `${noun} ${index + 1} is out of range (document has ${count})`),
  offsetOutOfRange: (offset: number, size: number) =>
    tagged("out_of_range", `Offset ${offset} is out of range (file has ${size} bytes)`),
  imageTooLarge: (width: number, height: number) => tagged("too_large", `Image is too large to render (${width}x${height})`),
  tooLargeForBudget: (what: string) => tagged("too_large", `${what} is too large to fit the response budget`),
  imageDamaged: (format: string, detail: string) => tagged("damaged", `${format} image is damaged: ${detail}`),
  unsupportedImage: (format = "This image format") => tagged("unsupported_format", `${format} is not supported for rendering yet`),
  imageBudgetExhausted: () => tagged("timeout", "Image skipped: this page already used its decoding budget"),
  busy: () => tagged("timeout", "The viewer is busy with other documents; try again"),
  slowWindow: () => tagged("timeout", "This part of the sheet is too far in to read in time"),
  unavailable: (rpc: string, kind: string) => tagged("invalid_request", `${rpc} is not available for ${kind} documents`),
} as const;

function mib(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))} MiB`;
}
