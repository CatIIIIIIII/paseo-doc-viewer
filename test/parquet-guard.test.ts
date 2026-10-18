import type { FileMetaData } from "hyparquet";
import { describe, expect, it } from "vitest";
import { checkRead, PARQUET_MAX_READ_BYTES, readDecision, type ParquetModel } from "../server/parquet";

const MiB = 1024 * 1024;

interface ChunkSpec {
  name: string;
  compressed: number;
  uncompressed: number;
  codec?: string;
  pageIndexed?: boolean;
}

function metadata(groups: { rows: number; chunks: ChunkSpec[] }[]): FileMetaData {
  const row_groups = groups.map(({ rows, chunks }) => ({
    num_rows: BigInt(rows),
    columns: chunks.map((chunk) => ({
      ...(chunk.pageIndexed ? { offset_index_offset: 4n } : {}),
      meta_data: {
        path_in_schema: [chunk.name],
        codec: chunk.codec ?? "SNAPPY",
        total_compressed_size: BigInt(chunk.compressed),
        total_uncompressed_size: BigInt(chunk.uncompressed),
      },
    })),
  }));
  return { row_groups, num_rows: BigInt(groups.reduce((sum, group) => sum + group.rows, 0)) } as unknown as FileMetaData;
}

const model = (meta: FileMetaData): ParquetModel => ({ metadata: meta, rowCount: Number(meta.num_rows), columns: [], columnsTruncated: false });
const all = new Set(["id", "output"]);

describe("Parquet read guard decides from the footer", () => {
  it("refuses one row group whose chunks exceed the budget, like the 97 MB single-group file", () => {
    const meta = metadata([{ rows: 28_000, chunks: [{ name: "id", compressed: MiB, uncompressed: MiB }, { name: "output", compressed: 93 * MiB, uncompressed: 94 * MiB }] }]);
    expect(readDecision(meta, all, 0, 200)).toEqual({ ok: false, reason: "memory", group: 0, bytes: 189 * MiB });
    expect(() => checkRead(model(meta), all, 0, 200)).toThrow(/its only row group needs about 189 MiB .* at most 64 MiB .*smaller row groups/);
  });

  it("opens the same bytes split into small row groups, reading only the groups in range", () => {
    const groups = Array.from({ length: 14 }, () => ({ rows: 2_000, chunks: [{ name: "id", compressed: MiB, uncompressed: MiB }, { name: "output", compressed: 6 * MiB, uncompressed: 6 * MiB }] }));
    const meta = metadata(groups);
    expect(readDecision(meta, all, 0, 200)).toEqual({ ok: true });
    expect(readDecision(meta, all, 27_800, 28_000)).toEqual({ ok: true });
    // A window spanning two groups counts each group separately, not their sum.
    expect(readDecision(meta, all, 1_900, 2_100)).toEqual({ ok: true });
  });

  it("counts only the columns shown, and only compressed bytes for page-indexed chunks", () => {
    const big = { name: "output", compressed: 40 * MiB, uncompressed: 40 * MiB };
    const meta = metadata([{ rows: 1_000, chunks: [{ name: "id", compressed: MiB, uncompressed: MiB }, big] }]);
    expect(readDecision(meta, new Set(["id"]), 0, 200)).toEqual({ ok: true });
    expect(readDecision(meta, all, 0, 200)).toMatchObject({ ok: false, reason: "memory" });
    const indexed = metadata([{ rows: 1_000, chunks: [{ ...big, pageIndexed: true }] }]);
    expect(readDecision(indexed, all, 0, 200)).toEqual({ ok: true });
  });

  it("allows a group exactly at the budget and refuses one byte more", () => {
    const at = metadata([{ rows: 10, chunks: [{ name: "id", compressed: PARQUET_MAX_READ_BYTES / 2, uncompressed: PARQUET_MAX_READ_BYTES / 2 }] }]);
    expect(readDecision(at, all, 0, 10)).toEqual({ ok: true });
    const over = metadata([{ rows: 10, chunks: [{ name: "id", compressed: PARQUET_MAX_READ_BYTES / 2, uncompressed: PARQUET_MAX_READ_BYTES / 2 + 1 }] }]);
    expect(readDecision(over, all, 0, 10)).toMatchObject({ ok: false, reason: "memory" });
  });

  it("names the row group when the file has several, and refuses LZO before reading", () => {
    const meta = metadata([
      { rows: 10, chunks: [{ name: "id", compressed: 10, uncompressed: 10 }] },
      { rows: 10, chunks: [{ name: "id", compressed: 50 * MiB, uncompressed: 50 * MiB }] },
    ]);
    expect(() => checkRead(model(meta), all, 0, 20)).toThrow(/row group 2 of 2 needs about 100 MiB/);
    const lzo = metadata([{ rows: 10, chunks: [{ name: "id", compressed: 10, uncompressed: 10, codec: "LZO" }] }]);
    expect(readDecision(lzo, all, 0, 10)).toEqual({ ok: false, reason: "codec", codec: "LZO" });
    expect(() => checkRead(model(lzo), all, 0, 10)).toThrow(/LZO/);
  });
});
