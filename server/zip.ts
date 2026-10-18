import { isUtf8 } from "node:buffer";
import { createReadStream } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { createInflateRaw, inflateRawSync } from "node:zlib";
import { ERROR_MESSAGES } from "../shared/errors";

export interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  size: number;
  localOffset: number;
}

export interface ZipLimits {
  maxEntries: number;
  maxTotalBytes: number;
  maxPartBytes: number;
  streamed?: (name: string) => boolean;
}

export interface ZipIndex {
  path: string;
  entries: Map<string, ZipEntry>;
}

const EOCD = 0x06054b50;
const ZIP64_LOCATOR = 0x07064b50;
const ZIP64_EOCD = 0x06064b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
const MAX_COMMENT = 0xffff;
const MAX_DIRECTORY_BYTES = 32 * 1024 * 1024;
const STORED = 0;
const DEFLATED = 8;
const AES = 99;
const XML_PART = /\.(xml|rels|vml)$/i;
const MiB = 1024 * 1024;

const damaged = (extension: string) => new Error(ERROR_MESSAGES.invalidOffice(extension));

async function readAt(handle: FileHandle, position: number, length: number): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  let read = 0;
  while (read < length) {
    const { bytesRead } = await handle.read(buffer, read, length - read, position + read);
    if (bytesRead === 0) break;
    read += bytesRead;
  }
  return buffer.subarray(0, read);
}

interface Directory {
  count: number;
  size: number;
  offset: number;
}

async function locateDirectory(handle: FileHandle, fileSize: number, extension: string): Promise<Directory> {
  const tailStart = Math.max(0, fileSize - (22 + MAX_COMMENT));
  const tail = await readAt(handle, tailStart, fileSize - tailStart);
  let at = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) === EOCD) {
      at = i;
      break;
    }
  }
  if (at < 0) throw damaged(extension);
  const directory = { count: tail.readUInt16LE(at + 10), size: tail.readUInt32LE(at + 12), offset: tail.readUInt32LE(at + 16) };
  if (directory.count !== 0xffff && directory.size !== 0xffffffff && directory.offset !== 0xffffffff) return directory;
  const locator = at - 20;
  if (locator < 0 || tail.readUInt32LE(locator) !== ZIP64_LOCATOR) {
    if (directory.size !== 0xffffffff && directory.offset !== 0xffffffff) return directory;
    throw damaged(extension);
  }
  const record = await readAt(handle, Number(tail.readBigUInt64LE(locator + 8)), 56);
  if (record.length < 56 || record.readUInt32LE(0) !== ZIP64_EOCD) throw damaged(extension);
  return {
    count: Number(record.readBigUInt64LE(32)),
    size: Number(record.readBigUInt64LE(40)),
    offset: Number(record.readBigUInt64LE(48)),
  };
}

function zip64Fields(extra: Buffer, needs: { size: boolean; compressed: boolean; offset: boolean }) {
  for (let at = 0; at + 4 <= extra.length; ) {
    const id = extra.readUInt16LE(at);
    const length = extra.readUInt16LE(at + 2);
    if (id === 0x0001) {
      let field = at + 4;
      const next = () => {
        const value = field + 8 <= at + 4 + length ? Number(extra.readBigUInt64LE(field)) : undefined;
        field += 8;
        return value;
      };
      return {
        size: needs.size ? next() : undefined,
        compressed: needs.compressed ? next() : undefined,
        offset: needs.offset ? next() : undefined,
      };
    }
    at += 4 + length;
  }
  return {};
}

const UNICODE_PATH = 0x7075;

// JSZip's utils.resolve: drops "." and empty segments and applies "..".
function resolveLikeJszip(path: string): string {
  const parts = path.split("/");
  const result: string[] = [];
  parts.forEach((part, index) => {
    if (part === "." || (part === "" && index !== 0 && index !== parts.length - 1)) return;
    if (part === "..") result.pop();
    else result.push(part);
  });
  return result.join("/");
}

// mammoth reads .docx packages with JSZip, which decodes every name as UTF-8, prefers an Info-ZIP
// Unicode Path field and resolves "." and ".." segments. A name it reads differently could hide
// the part mammoth parses from the checks here, so for .docx such names are refused.
function jszipReadsSameName(name: string, nameBytes: Buffer, flags: number, extra: Buffer): boolean {
  for (let at = 0; at + 4 <= extra.length; at += 4 + extra.readUInt16LE(at + 2)) {
    if (extra.readUInt16LE(at) === UNICODE_PATH) return false;
  }
  if (flags & 0x800 ? !isUtf8(nameBytes) : nameBytes.some((byte) => byte >= 0x80)) return false;
  return resolveLikeJszip(name) === name;
}

export async function readZipIndex(path: string, fileSize: number, extension: string, limits: ZipLimits): Promise<ZipIndex> {
  const handle = await open(path, "r");
  try {
    const directory = await locateDirectory(handle, fileSize, extension);
    if (directory.count > limits.maxEntries) {
      throw new Error(ERROR_MESSAGES.archiveTooLarge(`${directory.count} parts (the limit is ${limits.maxEntries})`));
    }
    if (directory.size > MAX_DIRECTORY_BYTES || directory.offset + directory.size > fileSize) throw damaged(extension);
    const table = await readAt(handle, directory.offset, directory.size);
    const entries = new Map<string, ZipEntry>();
    let total = 0;
    let at = 0;
    for (let n = 0; at < table.length; n++) {
      if (n >= limits.maxEntries) {
        throw new Error(ERROR_MESSAGES.archiveTooLarge(`more than ${limits.maxEntries} parts`));
      }
      if (at + 46 > table.length || table.readUInt32LE(at) !== CENTRAL) throw damaged(extension);
      const flags = table.readUInt16LE(at + 8);
      const method = table.readUInt16LE(at + 10);
      let compressedSize = table.readUInt32LE(at + 20);
      let size = table.readUInt32LE(at + 24);
      const nameLength = table.readUInt16LE(at + 28);
      const extraLength = table.readUInt16LE(at + 30);
      const commentLength = table.readUInt16LE(at + 32);
      let localOffset = table.readUInt32LE(at + 42);
      const nameBytes = table.subarray(at + 46, at + 46 + nameLength);
      const name = nameBytes.toString(flags & 0x800 ? "utf8" : "latin1");
      if (size === 0xffffffff || compressedSize === 0xffffffff || localOffset === 0xffffffff) {
        const wide = zip64Fields(table.subarray(at + 46 + nameLength, at + 46 + nameLength + extraLength), {
          size: size === 0xffffffff,
          compressed: compressedSize === 0xffffffff,
          offset: localOffset === 0xffffffff,
        });
        size = wide.size ?? size;
        compressedSize = wide.compressed ?? compressedSize;
        localOffset = wide.offset ?? localOffset;
      }
      if (extension === "docx" && !jszipReadsSameName(name, nameBytes, flags, table.subarray(at + 46 + nameLength, at + 46 + nameLength + extraLength))) {
        throw damaged(extension);
      }
      at += 46 + nameLength + extraLength + commentLength;
      if (flags & 0x1 || method === AES) throw new Error(ERROR_MESSAGES.encryptedOffice());
      if (method !== STORED && method !== DEFLATED) throw damaged(extension);
      if (localOffset + compressedSize > fileSize) throw damaged(extension);
      if (XML_PART.test(name) && size > limits.maxPartBytes && !limits.streamed?.(name)) {
        throw new Error(ERROR_MESSAGES.archiveTooLarge(`${name} is ${Math.round(size / MiB)} MiB (the limit is ${limits.maxPartBytes / MiB} MiB)`));
      }
      total += size;
      if (total > limits.maxTotalBytes) {
        throw new Error(ERROR_MESSAGES.archiveTooLarge(`its parts unpack to more than ${limits.maxTotalBytes / MiB} MiB`));
      }
      // Readers disagree on which copy of a duplicated name wins (JSZip keeps the last), so a
      // checked part could differ from the one parsed. Part names must be unique in a package.
      if (entries.has(name)) throw damaged(extension);
      entries.set(name, { name, method, compressedSize, size, localOffset });
    }
    return { path, entries };
  } finally {
    await handle.close();
  }
}

async function dataStart(handle: FileHandle, entry: ZipEntry, extension: string): Promise<number> {
  const header = await readAt(handle, entry.localOffset, 30);
  if (header.length < 30 || header.readUInt32LE(0) !== LOCAL) throw damaged(extension);
  return entry.localOffset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
}

export async function readEntry(index: ZipIndex, name: string, extension: string): Promise<Buffer | null> {
  const entry = index.entries.get(name);
  if (!entry) return null;
  const handle = await open(index.path, "r");
  let raw: Buffer;
  try {
    raw = await readAt(handle, await dataStart(handle, entry, extension), entry.compressedSize);
  } finally {
    await handle.close();
  }
  if (raw.length < entry.compressedSize) throw damaged(extension);
  if (entry.method === STORED) return raw.subarray(0, entry.size);
  try {
    return inflateRawSync(raw, { maxOutputLength: Math.max(1, entry.size) });
  } catch (error) {
    console.error(`[doc-viewer] ${index.path}: ${name}:`, error);
    throw damaged(extension);
  }
}

export async function readText(index: ZipIndex, name: string, extension: string): Promise<string | null> {
  return (await readEntry(index, name, extension))?.toString("utf8") ?? null;
}

export async function* streamEntry(index: ZipIndex, name: string, extension: string): AsyncGenerator<Buffer> {
  const entry = index.entries.get(name);
  if (!entry) return;
  const handle = await open(index.path, "r");
  let start: number;
  try {
    start = await dataStart(handle, entry, extension);
  } finally {
    await handle.close();
  }
  if (entry.compressedSize === 0) return;
  const source = createReadStream(index.path, { start, end: start + entry.compressedSize - 1, highWaterMark: 256 * 1024 });
  if (entry.method === STORED) {
    try {
      for await (const chunk of source) yield chunk as Buffer;
    } finally {
      source.destroy();
    }
    return;
  }
  const inflate = createInflateRaw();
  source.on("error", (error) => inflate.destroy(error));
  source.pipe(inflate);
  let produced = 0;
  try {
    for await (const chunk of inflate) {
      produced += (chunk as Buffer).length;
      if (produced > entry.size) throw damaged(extension);
      yield chunk as Buffer;
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("[doc:")) throw error;
    console.error(`[doc-viewer] ${index.path}: ${name}:`, error);
    throw damaged(extension);
  } finally {
    source.destroy();
    inflate.destroy();
  }
}

export interface ZipMarkup {
  tags: number;
  xmlBytes: number;
}

// Counts tags in every part named like XML plus `markupParts`, the parts a reader parses as XML
// under another name.
export async function verifyEntries(index: ZipIndex, extension: string, maxMarkup: number, markupParts: ReadonlySet<string> = new Set()): Promise<ZipMarkup> {
  let markup = 0;
  let xmlBytes = 0;
  for (const entry of index.entries.values()) {
    const xml = XML_PART.test(entry.name) || markupParts.has(entry.name);
    if (xml) xmlBytes += entry.size;
    if (entry.method !== DEFLATED && !xml) continue;
    for await (const chunk of streamEntry(index, entry.name, extension)) {
      if (!xml) continue;
      for (let at = chunk.indexOf(0x3c); at >= 0; at = chunk.indexOf(0x3c, at + 1)) markup++;
      if (markup > maxMarkup) {
        throw new Error(ERROR_MESSAGES.archiveTooLarge(`it has more than ${maxMarkup.toLocaleString("en-US")} XML tags`));
      }
    }
  }
  return { tags: markup, xmlBytes };
}
