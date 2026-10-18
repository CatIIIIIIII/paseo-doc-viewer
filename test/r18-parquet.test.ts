import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { listRecent, openDocument, readCell, readRows, searchDocument } from "../server/documents";
import { KIND_GROUP } from "../shared/browse";
import { kindForPath } from "../shared/kinds";
import { CELL_FULL_MAX_CHARS, MAX_RESPONSE_BYTES, XLSX_MAX_CELL_CHARS } from "../shared/limits";
import { inspectorFields } from "../client/cell-detail";
import { checkRead, openParquet, PARQUET_MAX_READ_BYTES } from "../server/parquet";
import { FIXTURES, responseBytes, workspace } from "./helpers";

// Fixtures come from test/fixtures/parquet/make.py (pyarrow). evals.parquet: 300 rows in three
// row groups of 100 with a page index, snappy, nested struct, list, timestamp, decimal, int64, binary.
const fixture = (name: string) => readFileSync(join(FIXTURES, "parquet", name));
const evals = () => workspace({ "runs/evals.parquet": fixture("evals.parquet") });
const ref = (root: string) => ({ root, path: "runs/evals.parquet" });

const COLUMNS = ["id", "output", "score", "passed", "meta.model", "meta.latency_ms", "meta.usage.in", "meta.usage.out", "tags", "created", "cost", "big", "blob", "note"];

describe("R18: Parquet in the sheet grid", () => {
  it("registers .parquet as a data kind and lists it with spreadsheets", async () => {
    expect(kindForPath("x/Y.PARQUET")).toBe("parquet");
    expect(KIND_GROUP.parquet).toBe("excel");
    const listed = await listRecent(evals(), { group: "excel" });
    expect(listed.entries.map((entry) => [entry.path, entry.kind])).toEqual([["runs/evals.parquet", "parquet"]]);
  });

  it("opens from the footer with the row count and flattened struct columns", async () => {
    const opened = await openDocument(ref(evals()));
    expect(opened).toMatchObject({ kind: "parquet", sheets: [{ name: "evals.parquet", rowCount: 300, columnCount: COLUMNS.length, countsApproximate: false }] });
    const window = await readRows(ref(evals()), { sheet: 0, rowOffset: 0, columnOffset: 0 });
    expect(window.columnNames).toEqual(COLUMNS);
    expect(window.rows).toHaveLength(200);
    expect(window.nextRowOffset).toBe(200);
    expect(responseBytes(window)).toBeLessThan(MAX_RESPONSE_BYTES);
  });

  it("pages across row groups and shows column types in the inspector", async () => {
    const window = await readRows(ref(evals()), { sheet: 0, rowOffset: 99, columnOffset: 0, maxRows: 3, detail: true });
    const at = (row: number, name: string) => window.rows[row]![COLUMNS.indexOf(name)];
    const detail = (row: number, name: string) => window.details![row]![COLUMNS.indexOf(name)]!;
    expect(window.rows.map((row) => row[0])).toEqual(["case-99", "case-100", "case-101"]);
    expect(at(0, "meta.usage.out")).toBe("198");
    expect(at(0, "tags")).toBe('2 items: ["eval","bucket-3"]');
    expect(at(1, "tags")).toBe("[]");
    expect(at(0, "created")).toBe("2026-10-01T01:39:00.000Z");
    // int64 beyond 2^53 keeps every digit; unannotated byte arrays are binary.
    expect(at(0, "big")).toBe("4611686018427388003");
    expect(at(0, "blob")).toBe("binary, 3 bytes");
    expect(at(0, "note")).toBe("null");
    expect(detail(0, "meta.latency_ms")).toMatchObject({ type: "parquet", valueType: "number", columnType: "int32 (Parquet INT32)", keyPath: "meta.latency_ms" });
    expect(detail(0, "created").columnType).toBe("timestamp, microseconds, UTC (Parquet INT64)");
    expect(detail(0, "cost").columnType).toBe("decimal(10, 4) (Parquet FIXED_LEN_BYTE_ARRAY)");
    expect(detail(0, "tags").columnType).toBe("list of string (Parquet BYTE_ARRAY)");
    expect(detail(0, "blob").columnType).toBe("binary (Parquet BYTE_ARRAY)");
    expect(inspectorFields(detail(0, "id")).map((field) => field.label)).toContain("Column type");
  });

  it("cuts long strings in the grid and returns them in full on request", async () => {
    const window = await readRows(ref(evals()), { sheet: 0, rowOffset: 0, columnOffset: 0, maxRows: 1, detail: true });
    expect(window.rows[0]![1]).toHaveLength(XLSX_MAX_CELL_CHARS);
    expect(window.details![0]![1]).toMatchObject({ truncated: true });
    const full = await readCell(ref(evals()), { sheet: 0, row: 0, column: 1 });
    expect(full).toMatchObject({ format: "text", truncated: false });
    expect(full.text.endsWith(" END")).toBe(true);
    expect(full.text.length).toBeLessThan(CELL_FULL_MAX_CHARS);
    const record = await readCell(ref(evals()), { sheet: 0, row: 1, column: null });
    expect(record.format).toBe("json");
    expect(JSON.parse(record.text)).toMatchObject({ id: "case-1", meta: { model: "model-a", usage: { in: 1, out: 2 } }, tags: ["eval", "bucket-1"], blob: "binary, 3 bytes" });
    expect(record.text).toContain('"big": 4611686018427387905');
  });

  it("finds text in nested columns and resumes across row groups", async () => {
    const root = evals();
    const first = await searchDocument(ref(root), "model-b");
    expect(first.matches[0]!.target).toEqual({ type: "cell", sheet: 0, row: 0, column: COLUMNS.indexOf("meta.model") });
    let total = first.matches.length;
    let cursor = first.next;
    while (cursor) {
      const next = await searchDocument(ref(root), "model-b", cursor);
      total += next.matches.length;
      cursor = next.next;
    }
    expect(total).toBe(150);
  });

  it.each(["none", "gzip", "brotli", "zstd", "lz4"])("reads %s compression", async (codec) => {
    const root = workspace({ "c.parquet": fixture(`codec-${codec}.parquet`) });
    const window = await readRows({ root, path: "c.parquet" }, { sheet: 0, rowOffset: 0, columnOffset: 0 });
    expect(window.columnNames).toEqual(["id", "output", "score", "meta.model", "meta.latency_ms", "meta.usage.in", "meta.usage.out"]);
    expect(window.rows[4]!.slice(0, 2)).toEqual(["case-4", "short answer 4"]);
  });

  it("keeps structs deeper than the flattening depth in one cell", async () => {
    const root = workspace({ "d.parquet": fixture("deep.parquet") });
    const window = await readRows({ root, path: "d.parquet" }, { sheet: 0, rowOffset: 0, columnOffset: 0 });
    expect(window.columnNames).toEqual(["a.b.c"]);
    expect(window.rows).toEqual([['{"d":1}']]);
  });

  it("reports a damaged file as unreadable", async () => {
    const bytes = fixture("evals.parquet");
    const root = workspace({ "cut.parquet": bytes.subarray(0, bytes.length - 100), "fake.parquet": "PAR1 not really" });
    await expect(openDocument({ root, path: "cut.parquet" })).rejects.toThrow(/Parquet|damaged|read/i);
    await expect(openDocument({ root, path: "fake.parquet" })).rejects.toThrow();
  });

  it("refuses reads past the memory guard and codecs without a decoder before reading", async () => {
    const bytes = fixture("evals.parquet");
    const root = workspace({ "e.parquet": bytes });
    const model = await openParquet(join(root, "e.parquet"), bytes.length);
    expect(() => checkRead(model, new Set(["id"]), 0, 300)).not.toThrow();
    const chunk = model.metadata.row_groups[1]!.columns[0]!;
    chunk.meta_data!.total_compressed_size = BigInt(PARQUET_MAX_READ_BYTES + 1);
    // Row group 1 holds rows 100-199: pages outside it are still readable.
    expect(() => checkRead(model, new Set(["id"]), 0, 100)).not.toThrow();
    expect(() => checkRead(model, new Set(["output"]), 100, 200)).not.toThrow();
    expect(() => checkRead(model, new Set(["id"]), 150, 160)).toThrow(/row group 2 holds/);
    chunk.meta_data!.total_compressed_size = 10n;
    chunk.meta_data!.codec = "LZO";
    expect(() => checkRead(model, new Set(["id"]), 150, 160)).toThrow(/LZO/);
  });
});
