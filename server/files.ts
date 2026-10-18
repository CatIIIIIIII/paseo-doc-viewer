import { constants } from "node:fs";
import { open, realpath, stat, type FileHandle } from "node:fs/promises";
import { basename, relative } from "node:path";
import { resolveInside } from "./paths";
import { MEDIA_MAX_CHUNK_BYTES } from "../shared/limits";
import { ERROR_MESSAGES } from "../shared/errors";
import { kindForPath } from "../shared/kinds";
import { safeFileName } from "../shared/safe-text";

export const MAX_DOWNLOAD_BYTES = 128 * 1024 * 1024;
const revision = (info: Awaited<ReturnType<FileHandle["stat"]>>) => `${info.dev}-${info.ino}-${info.size}-${info.mtimeMs}-${info.ctimeMs}`;
const changed = () => new Error("The file changed. Prepare the download again.");

// Downloads are limited to the formats the viewer lists, outside hidden files and folders,
// so `/doc .env` or a link into `.git` cannot export credentials.
function checkDownloadable(path: string): void {
  if (!kindForPath(path)) throw new Error(ERROR_MESSAGES.notDownloadable());
  if (path.split(/[\\/]/).some((segment) => segment.startsWith(".") && segment !== "." && segment !== "..")) throw new Error(ERROR_MESSAGES.hiddenDownload());
}

async function file<T>(root: string, path: string, read: (handle: FileHandle, size: number, stamp: string) => Promise<T>): Promise<T> {
  checkDownloadable(path);
  const realRoot = await realpath(root);
  const resolved = await resolveInside(root, path);
  checkDownloadable(relative(realRoot, resolved));
  // Non-blocking, so a FIFO is rejected below instead of holding a threadpool thread until a writer appears.
  const handle = await open(resolved, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0)).catch((error: NodeJS.ErrnoException) => {
    throw error.code === "ELOOP" ? changed() : error;
  });
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error("Only regular files can be downloaded");
    // A directory swapped for a link after resolving would open a file elsewhere; the
    // handle must still be the file the workspace path resolves to now.
    const current = await stat(await resolveInside(root, path));
    if (current.dev !== info.dev || current.ino !== info.ino) throw changed();
    if (info.size > MAX_DOWNLOAD_BYTES) throw new Error("Original download is limited to 128 MiB");
    return await read(handle, info.size, revision(info));
  } finally { await handle.close(); }
}

export function fileInfo(root: string, path: string) {
  return file(root, path, async (_handle, size, stamp) => ({
    revision: stamp, size, mimeType: "application/octet-stream",
    name: safeFileName(basename(path)),
  }));
}

export function fileChunk(root: string, path: string, expected: string, offset: number, length: number) {
  return file(root, path, async (handle, size, stamp) => {
    if (stamp !== expected) throw changed();
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > size || !Number.isSafeInteger(length) || length < 1) throw new Error("Invalid file range");
    const bytes = Buffer.alloc(Math.min(length, MEDIA_MAX_CHUNK_BYTES, size - offset));
    let read = 0;
    while (read < bytes.length) {
      const { bytesRead } = await handle.read(bytes, read, bytes.length - read, offset + read);
      if (!bytesRead) throw new Error("The file ended unexpectedly. Prepare the download again.");
      read += bytesRead;
    }
    if (revision(await handle.stat()) !== stamp) throw changed();
    const end = offset + read;
    return { revision: stamp, offset, size, data: bytes.toString("base64"), nextOffset: end < size ? end : null };
  });
}
