import { open, type FileHandle } from "node:fs/promises";

const HEADER_BYTES = 512;
const DIFAT_IN_HEADER = 109;
const END_OF_CHAIN = 0xfffffffe;
const MAX_DIRECTORY_SECTORS = 64;
const ENTRY_BYTES = 128;

async function readAt(handle: FileHandle, position: number, length: number): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await handle.read(buffer, 0, length, position);
  return buffer.subarray(0, bytesRead);
}

export async function compoundStreamNames(path: string): Promise<string[]> {
  const handle = await open(path, "r");
  try {
    const header = await readAt(handle, 0, HEADER_BYTES);
    if (header.length < HEADER_BYTES) return [];
    const shift = header.readUInt16LE(0x1e);
    if (shift !== 9 && shift !== 12) return [];
    const sectorSize = 1 << shift;
    const perFatSector = sectorSize / 4;
    const offset = (sector: number) => (sector + 1) * sectorSize;
    const fatSectors = new Map<number, Buffer>();
    const next = async (sector: number): Promise<number> => {
      const slot = Math.floor(sector / perFatSector);
      if (slot >= DIFAT_IN_HEADER) return END_OF_CHAIN;
      let table = fatSectors.get(slot);
      if (!table) {
        table = await readAt(handle, offset(header.readUInt32LE(0x4c + slot * 4)), sectorSize);
        fatSectors.set(slot, table);
      }
      const at = (sector % perFatSector) * 4;
      return at + 4 <= table.length ? table.readUInt32LE(at) : END_OF_CHAIN;
    };
    const names: string[] = [];
    let sector = header.readUInt32LE(0x30);
    for (let count = 0; sector < END_OF_CHAIN - 5 && count < MAX_DIRECTORY_SECTORS; count++) {
      const block = await readAt(handle, offset(sector), sectorSize);
      for (let at = 0; at + ENTRY_BYTES <= block.length; at += ENTRY_BYTES) {
        const length = Math.min(64, block.readUInt16LE(at + 64));
        if (length >= 2) names.push(block.toString("utf16le", at, at + length - 2));
      }
      sector = await next(sector);
    }
    return names;
  } finally {
    await handle.close();
  }
}

export async function isEncryptedOoxml(path: string): Promise<boolean> {
  const names = await compoundStreamNames(path);
  return names.includes("EncryptionInfo") && names.includes("EncryptedPackage");
}
