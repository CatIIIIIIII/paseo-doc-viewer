import { constants } from "node:fs";
import { open, stat, type FileHandle } from "node:fs/promises";
import { basename } from "node:path";
import { resolveInside } from "./paths";
import { MEDIA_MAX_CHUNK_BYTES } from "../shared/limits";

export const MAX_DOWNLOAD_BYTES = 128 * 1024 * 1024;
const revision = (info: Awaited<ReturnType<FileHandle["stat"]>>) => `${info.dev}-${info.ino}-${info.size}-${info.mtimeMs}-${info.ctimeMs}`;

async function file<T>(root: string, path: string, read: (handle: FileHandle, size: number, stamp: string, resolved: string) => Promise<T>): Promise<T> {
  const resolved = await resolveInside(root, path);
  // Non-blocking, so a FIFO is rejected below instead of holding a threadpool thread until a writer appears.
  const handle = await open(resolved, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error("Only regular files can be downloaded");
    if (info.size > MAX_DOWNLOAD_BYTES) throw new Error("Original download is limited to 128 MiB");
    return await read(handle, info.size, revision(info), resolved);
  } finally { await handle.close(); }
}

export function fileInfo(root: string, path: string) {
  return file(root, path, async (_handle, size, stamp) => ({
    revision: stamp, size, mimeType: "application/octet-stream",
    name: basename(path).replace(/[\\/\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/g, "_") || "document",
  }));
}

export function fileChunk(root: string, path: string, expected: string, offset: number, length: number) {
  return file(root, path, async (handle, size, stamp, resolved) => {
    if (stamp !== expected) throw new Error("The file changed. Prepare the download again.");
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > size || !Number.isSafeInteger(length) || length < 1) throw new Error("Invalid file range");
    const bytes = Buffer.alloc(Math.min(length, MEDIA_MAX_CHUNK_BYTES, size - offset));
    let read = 0;
    while (read < bytes.length) {
      const { bytesRead } = await handle.read(bytes, read, bytes.length - read, offset + read);
      if (!bytesRead) throw new Error("The file ended unexpectedly. Prepare the download again.");
      read += bytesRead;
    }
    if (revision(await handle.stat()) !== stamp || revision(await stat(resolved)) !== stamp) throw new Error("The file changed. Prepare the download again.");
    const end = offset + read;
    return { revision: stamp, offset, size, data: bytes.toString("base64"), nextOffset: end < size ? end : null };
  });
}
