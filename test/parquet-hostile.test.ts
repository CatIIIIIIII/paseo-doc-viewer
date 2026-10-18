import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { openDocument, readCell, readRows, searchDocument } from "../server/documents";
import { DATA_MAX_COLUMNS, MAX_RESPONSE_BYTES } from "../shared/limits";
import { FIXTURES, responseBytes, workspace } from "./helpers";

// Forged or damaged Parquet files must end in an error message, never a crash, a hang or a large allocation.
const fixture = (name: string) => readFileSync(join(FIXTURES, "parquet", name));

function withFooterLength(bytes: Buffer, length: number): Buffer {
  const copy = Buffer.from(bytes);
  copy.writeUInt32LE(length, copy.length - 8);
  return copy;
}

describe("Parquet: hostile input", () => {
  it("refuses a metadata length over the footer cap before reading it", async () => {
    const root = workspace({ "huge.parquet": withFooterLength(fixture("evals.parquet"), 0xfffffff0) });
    const before = process.memoryUsage().arrayBuffers;
    await expect(openDocument({ root, path: "huge.parquet" })).rejects.toThrow(/too large to preview: the Parquet footer/);
    expect(process.memoryUsage().arrayBuffers - before).toBeLessThan(64 * 1024 * 1024);
  });

  it("refuses a metadata length larger than the file as damaged, without allocating it", async () => {
    const root = workspace({ "lying.parquet": withFooterLength(fixture("codec-none.parquet"), 20 * 1024 * 1024) });
    await expect(openDocument({ root, path: "lying.parquet" })).rejects.toThrow(/Parquet|damaged/i);
  });

  it("reports a file truncated in the middle with its footer kept as damaged", async () => {
    const bytes = fixture("evals.parquet");
    const cut = Buffer.concat([bytes.subarray(0, Math.floor(bytes.length / 2)), bytes.subarray(bytes.length - 8)]);
    const root = workspace({ "cut.parquet": cut, "tiny.parquet": "PAR1PAR1", "empty.parquet": "" });
    await expect(openDocument({ root, path: "cut.parquet" })).rejects.toThrow(/Parquet|damaged/i);
    await expect(openDocument({ root, path: "tiny.parquet" })).rejects.toThrow();
    await expect(openDocument({ root, path: "empty.parquet" })).rejects.toThrow();
  });

  it("reports damaged column data as an error after a valid footer", async () => {
    const bytes = Buffer.from(fixture("codec-none.parquet"));
    // Overwrite the column chunks (between the leading magic and the footer) with garbage.
    const footer = bytes.readUInt32LE(bytes.length - 8);
    bytes.fill(0xff, 4, bytes.length - 8 - footer);
    const root = workspace({ "garbled.parquet": bytes });
    await openDocument({ root, path: "garbled.parquet" });
    await expect(readRows({ root, path: "garbled.parquet" }, { sheet: 0, rowOffset: 0, columnOffset: 0 })).rejects.toThrow();
    await expect(readCell({ root, path: "garbled.parquet" }, { sheet: 0, row: 0, column: 0 })).rejects.toThrow();
  });

  it("opens a 5,000-column schema with the column cap, inside the response budget", async () => {
    const root = workspace({ "wide.parquet": gunzipSync(fixture("wide-5000.parquet.gz")) });
    const opened = await openDocument({ root, path: "wide.parquet" });
    expect(opened.kind).toBe("parquet");
    expect(opened.kind === "parquet" && opened.sheets[0]!.columnCount).toBe(DATA_MAX_COLUMNS);
    const window = await readRows({ root, path: "wide.parquet" }, { sheet: 0, rowOffset: 0, columnOffset: 0 });
    expect(window.rows).toHaveLength(1);
    expect(responseBytes(window)).toBeLessThan(MAX_RESPONSE_BYTES);
    const found = await searchDocument({ root, path: "wide.parquet" }, "42");
    expect(found.matches.length).toBeGreaterThan(0);
  }, 30_000);
});
