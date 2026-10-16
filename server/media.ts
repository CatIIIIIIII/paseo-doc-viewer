import { open } from "node:fs/promises";
import { MEDIA_MAX_CHUNK_BYTES } from "../shared/limits";
import { ERROR_MESSAGES } from "../shared/errors";

const VIDEO_MIME_TYPES: Record<string, string> = {
  mp4: "video/mp4",
  m4v: "video/x-m4v",
  mov: "video/quicktime",
  webm: "video/webm",
};

export function videoMimeType(extension: string): string {
  return VIDEO_MIME_TYPES[extension] ?? "application/octet-stream";
}

export async function readChunk(
  path: string,
  size: number,
  offset: number,
  length: number,
): Promise<{ data: string; nextOffset: number | null }> {
  if (offset > size) throw new Error(ERROR_MESSAGES.offsetOutOfRange(offset, size));
  const wanted = Math.min(length, MEDIA_MAX_CHUNK_BYTES, size - offset);
  const buffer = Buffer.alloc(wanted);
  const handle = await open(path, "r");
  let read = 0;
  try {
    while (read < wanted) {
      const { bytesRead } = await handle.read(buffer, read, wanted - read, offset + read);
      if (bytesRead === 0) break;
      read += bytesRead;
    }
  } finally {
    await handle.close();
  }
  const end = offset + read;
  return { data: buffer.subarray(0, read).toString("base64"), nextOffset: end < size ? end : null };
}
