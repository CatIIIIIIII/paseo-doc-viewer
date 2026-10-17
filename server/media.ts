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

export function sliceChunk(bytes: Buffer, offset: number, length: number): { data: string; nextOffset: number | null } {
  if (offset > bytes.length) throw new Error(ERROR_MESSAGES.offsetOutOfRange(offset, bytes.length));
  const end = offset + Math.min(length, MEDIA_MAX_CHUNK_BYTES, bytes.length - offset);
  return { data: bytes.subarray(offset, end).toString("base64"), nextOffset: end < bytes.length ? end : null };
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

export function audioMimeType(extension: string): string {
  return ({ mp3: "audio/mpeg", m4a: "audio/mp4", wav: "audio/wav", flac: "audio/flac" } as Record<string, string>)[extension] ?? "application/octet-stream";
}
