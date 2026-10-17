import UTIF from "utif2";
import { ERROR_MESSAGES } from "../shared/errors";

// utif2 walks the IFD chain and sub-IFDs with no cycle detection and fills an array of `count`
// values per entry before checking the file length, so a 26-byte loop or one inflated count
// exhausts the heap and kills the plugin process. This walks the same structure first, with
// bounds, and refuses the file before UTIF.decode sees it.

// Bytes per value for the types utif2 decodes; it skips the others (6 = SBYTE and unknown types).
const TYPE_BYTES: Readonly<Record<number, number>> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8, 13: 4 };
// utif2 reads these from the offset even when they would fit in the entry.
const ALWAYS_OFFSET = new Set([5, 10, 11, 12]);
// BYTE and UNDEFINED values become views into the file, and ASCII is clamped to the file end.
const VIEW_TYPES = new Set([1, 7]);
const ASCII = 2;
const SUB_IFD_TAGS = new Set([330, 34665, 34853, 61440]);
const MODEL_TAG = 272;
const DNG_PRIVATE_DATA = 50740;
const MAX_DIRECTORIES = 1024;
const MAX_ENTRIES = 65_536;
const MAX_DEPTH = 8;
// Values utif2 copies into arrays and strings. Real files hold strip tables and short metadata.
const MAX_COPIED_BYTES = 16 * 1024 * 1024;

export function assertTiffStructure(bytes: Uint8Array): void {
  const damaged = (detail: string) => new Error(ERROR_MESSAGES.imageDamaged("TIFF", detail));
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const little = bytes[0] === 0x49;
  // Out-of-range reads give 0, like utif2's byte readers.
  const u16 = (at: number) => (at >= 0 && at + 2 <= bytes.length ? view.getUint16(at, little) : 0);
  const u32 = (at: number) => (at >= 0 && at + 4 <= bytes.length ? view.getUint32(at, little) : 0);
  const seen = new Set<number>();
  let entries = 0;
  let copied = 0;

  const visit = (offset: number, depth: number): void => {
    if (depth > MAX_DEPTH) throw damaged("image directories are nested too deeply");
    if (seen.has(offset)) throw damaged("image directories form a loop");
    seen.add(offset);
    if (seen.size > MAX_DIRECTORIES) throw damaged("too many image directories");
    const count = u16(offset);
    entries += count;
    if (entries > MAX_ENTRIES) throw damaged("too many directory entries");
    let model = "";
    for (let i = 0; i < count; i++) {
      const at = offset + 2 + i * 12;
      const tag = u16(at);
      const type = u16(at + 2);
      const num = u32(at + 4);
      const size = TYPE_BYTES[type];
      if (!size || num === 0) continue;
      const length = num * size;
      const valueAt = length <= 4 && !ALWAYS_OFFSET.has(type) ? at + 8 : u32(at + 8);
      if (type === ASCII) copied += Math.min(length, Math.max(0, bytes.length - valueAt));
      else if (!VIEW_TYPES.has(type)) {
        if (valueAt + length > bytes.length) throw damaged("a directory entry points outside the file");
        copied += length;
      }
      if (copied > MAX_COPIED_BYTES) throw damaged("too much directory data");
      if (tag === MODEL_TAG && type === ASCII) model = Buffer.from(bytes.subarray(valueAt, valueAt + Math.min(num - 1, 64))).toString("latin1");
      if (SUB_IFD_TAGS.has(tag) && !(tag === 330 && model === "DSLR-A100")) {
        for (let j = 0; j < num; j++) {
          if (type === 3) visit(u16(valueAt + j * 2), depth + 1);
          else if (type === 4 || type === 9 || type === 13) visit(u32(valueAt + j * 4), depth + 1);
          else if (VIEW_TYPES.has(type)) visit(bytes[valueAt + j] ?? 0, depth + 1);
        }
      }
      if (tag === DNG_PRIVATE_DATA) {
        if (!VIEW_TYPES.has(type)) throw damaged("unexpected DNG private data");
        const child = u32(valueAt);
        if (u16(child) < 300) visit(child, depth + 1);
      }
    }
  };

  // The main chain, stopping where UTIF.decode stops: a zero link or an invalid first entry type.
  for (let offset = u32(4); offset !== 0; ) {
    const count = u16(offset);
    const firstType = u16(offset + 4);
    if (count !== 0 && (firstType < 1 || firstType > 13)) break;
    visit(offset, 0);
    offset = u32(offset + 2 + count * 12);
  }
}

export function tiffDirectories(bytes: Buffer): UTIF.IFD[] {
  assertTiffStructure(bytes);
  // Maker notes are vendor IFDs that utif2 parses recursively; the viewer never needs them.
  const decode = UTIF.decode as (buffer: Buffer, options: { parseMN: boolean; debug: boolean }) => UTIF.IFD[];
  return decode(bytes, { parseMN: false, debug: false });
}
