import { describe, expect, it } from "vitest";
import { listRecent, openDocument, readCell, readRows, scanIssues, searchDocument } from "../server/documents";
import { KIND_GROUP } from "../shared/browse";
import { kindForPath } from "../shared/kinds";
import { CELL_FULL_MAX_CHARS, DATA_SAMPLE_ROWS, MAX_RESPONSE_BYTES, XLSX_MAX_CELL_CHARS } from "../shared/limits";
import { responseBytes, timed, workspace } from "./helpers";

const rows = (root: string, path: string, rowOffset = 0, options: { columnOffset?: number; maxRows?: number; detail?: boolean } = {}) =>
  readRows({ root, path }, { sheet: 0, rowOffset, columnOffset: options.columnOffset ?? 0, maxRows: options.maxRows, detail: options.detail });

const lines = (...values: string[]) => `${values.join("\n")}\n`;

const NESTED = lines(
  JSON.stringify({ id: 1, input: "q1", output: "a1", meta: { model: "m1", usage: { in: 3, out: 4 } }, tags: ["a", "b"] }),
  JSON.stringify({ id: 2, input: "q2", score: 0.5, meta: { model: "m2", deep: { x: { y: 1 } } }, passed: true, note: null }),
  "",
  "{\"id\": 3, \"input\": \"broken",
  "[1, 2]",
  JSON.stringify({ id: 12345678901234567890, input: "big" }).replace("12345678901234567000", "12345678901234567890"),
);

// 50,000 eval-style records with a nested object, an array and roughly 1 KB of text each.
function evalRecords(count: number, malformedEvery = 0): string {
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    if (malformedEvery && i % malformedEvery === malformedEvery - 1) {
      out.push(`{"id": "case-${i}", "output": `);
      continue;
    }
    out.push(JSON.stringify({
      id: `case-${i}`,
      input: `Question ${i}: what is ${i} squared?`,
      output: `The answer is ${i * i}. ${"Reasoning step. ".repeat(60)}`,
      score: (i % 10) / 10,
      passed: i % 3 !== 0,
      meta: { model: i % 2 ? "model-a" : "model-b", latency_ms: 100 + (i % 900) },
      tags: ["eval", `bucket-${i % 7}`],
    }));
  }
  return `${out.join("\n")}\n`;
}

describe("R16: JSON Lines in the sheet grid", () => {
  it("registers .jsonl and .ndjson as a data kind in the spreadsheet group", async () => {
    expect(kindForPath("runs/results.jsonl")).toBe("jsonl");
    expect(kindForPath("TRACE.NDJSON")).toBe("jsonl");
    expect(KIND_GROUP.jsonl).toBe("excel");
    const root = workspace({ "evals/results.jsonl": NESTED, "notes.txt": "x" });
    const listed = await listRecent(root, { group: "excel" });
    expect(listed.entries.map((entry) => [entry.path, entry.kind])).toEqual([["evals/results.jsonl", "jsonl"]]);
    expect(listed.counts.excel).toBe(1);
  });

  it("takes columns from the union of key paths, flattening nested objects and keeping arrays in one cell", async () => {
    const root = workspace({ "r.jsonl": NESTED });
    const opened = await openDocument({ root, path: "r.jsonl" });
    if (opened.kind !== "jsonl") throw new Error(`expected jsonl, got ${opened.kind}`);
    // Blank lines are not rows.
    expect(opened.sheets[0]).toMatchObject({ name: "r.jsonl", rowCount: 5, countsApproximate: false });
    const window = await rows(root, "r.jsonl");
    expect(window.kind).toBe("jsonl");
    expect(window.columnNames).toEqual([
      "id", "input", "output", "meta.model", "meta.usage.in", "meta.usage.out", "meta.deep.x", "tags", "score", "passed", "note", "(value)",
    ]);
    expect(opened.sheets[0]!.columnCount).toBe(12);
    const column = (name: string) => window.columnNames!.indexOf(name);
    expect(window.rows[0]![column("meta.usage.out")]).toBe("4");
    expect(window.rows[0]![column("tags")]).toBe('2 items: ["a","b"]');
    expect(window.rows[1]![column("meta.deep.x")]).toBe('{"y":1}');
    expect(window.rows[1]![column("passed")]).toBe("true");
    expect(window.rows[1]![column("note")]).toBe("null");
    expect(window.rows[1]![column("output")]).toBe("");
    expect(window.rows[2]![0]).toMatch(/^Invalid JSON: /);
    expect(window.rows[3]![column("(value)")]).toBe('2 items: [1,2]');
    // Integers beyond 2^53 keep every digit.
    expect(window.rows[4]![column("id")]).toBe("12345678901234567890");
    expect(window.nextRowOffset).toBeNull();
  });

  it("describes cells with their JSON type, key path and source line", async () => {
    const root = workspace({ "r.jsonl": NESTED });
    const window = await rows(root, "r.jsonl", 0, { detail: true });
    const column = (name: string) => window.columnNames!.indexOf(name);
    expect(window.details![0]![column("meta.model")]).toEqual({ type: "json", raw: "m1", display: "m1", valueType: "string", keyPath: "meta.model", line: 1 });
    expect(window.details![0]![column("tags")]).toMatchObject({ raw: '["a","b"]', valueType: "array" });
    expect(window.details![1]![column("output")]).toBeNull();
    expect(window.details![2]![0]).toMatchObject({ valueType: "invalid", line: 4, raw: "{\"id\": 3, \"input\": \"broken" });
    expect(window.details![2]![0]!.error).toBeTruthy();
    expect(window.details![4]![0]).toMatchObject({ line: 6 });
  });

  it("lists invalid lines and late keys as issues instead of failing the file", async () => {
    const sample = Array.from({ length: DATA_SAMPLE_ROWS + 5 }, (_, i) => JSON.stringify(i === DATA_SAMPLE_ROWS + 2 ? { id: i, late: 1 } : { id: i }));
    sample.splice(10, 0, "not json");
    const root = workspace({ "r.jsonl": lines(...sample) });
    const issues = await scanIssues({ root, path: "r.jsonl" });
    expect(issues.issues).toEqual([
      expect.objectContaining({ row: 10, line: 11, column: 0, kind: "invalid-json", formula: null }),
      expect.objectContaining({ row: DATA_SAMPLE_ROWS + 3, line: DATA_SAMPLE_ROWS + 4, kind: "unlisted-key", display: expect.stringContaining('"late"') }),
    ]);
    expect(issues.inspected).toEqual([{ sheet: 0, fromRow: 0, toRow: DATA_SAMPLE_ROWS + 6 }]);
    expect(issues.next).toBeNull();
  });

  it("handles CRLF line ends, a byte order mark and a last line without a newline", async () => {
    const root = workspace({ "w.ndjson": "﻿{\"a\":1}\r\n\r\n{\"a\":2}" });
    const window = await rows(root, "w.ndjson", 0, { detail: true });
    expect(window.columnNames).toEqual(["a"]);
    expect(window.rows).toEqual([["1"], ["2"]]);
    expect(window.details!.map((row) => row[0]!.line)).toEqual([1, 3]);
  });

  it("opens 50,000 records, pages like CSV and stays inside the response budget", async () => {
    const root = workspace({ "big.jsonl": evalRecords(50_000, 997) });
    const { value: opened, ms } = await timed(() => openDocument({ root, path: "big.jsonl" }));
    if (opened.kind !== "jsonl") throw new Error("expected jsonl");
    expect(opened.sheets[0]).toMatchObject({ rowCount: 50_000, columnCount: 8 });
    expect(ms).toBeLessThan(10_000);
    const first = await rows(root, "big.jsonl");
    expect(first.rows).toHaveLength(200);
    expect(first.nextRowOffset).toBe(200);
    expect(responseBytes(first)).toBeLessThan(MAX_RESPONSE_BYTES);
    const { value: late, ms: lateMs } = await timed(() => rows(root, "big.jsonl", 49_900));
    expect(late.rows[0]![0]).toBe("case-49900");
    expect(late.rows).toHaveLength(100);
    expect(late.nextRowOffset).toBeNull();
    expect(lateMs).toBeLessThan(2_000);
    const issues = await scanIssues({ root, path: "big.jsonl" });
    expect(issues.issues).toHaveLength(Math.floor(50_000 / 997));
    expect(issues.issues[0]).toMatchObject({ row: 996, line: 997, kind: "invalid-json" });
  });

  it("keeps cutting long values in the grid and returns them in full, up to the cap, on request", async () => {
    const long = "x".repeat(300_000);
    const answer = `First line\n${"y".repeat(5_000)}`;
    const root = workspace({ "l.jsonl": lines(JSON.stringify({ id: 1, output: long, answer, messages: [{ role: "user", content: "hi" }] })) });
    const window = await rows(root, "l.jsonl", 0, { detail: true });
    expect(window.rows[0]![1]).toHaveLength(XLSX_MAX_CELL_CHARS);
    expect(window.details![0]![1]).toMatchObject({ truncated: true });
    const full = await readCell({ root, path: "l.jsonl" }, { sheet: 0, row: 0, column: 1 });
    expect(full).toMatchObject({ format: "text", truncated: true, length: 300_000, line: 1 });
    expect(full.text).toHaveLength(CELL_FULL_MAX_CHARS);
    const second = await readCell({ root, path: "l.jsonl" }, { sheet: 0, row: 0, column: 2 });
    expect(second).toMatchObject({ text: answer, truncated: false, length: answer.length });
    const messages = await readCell({ root, path: "l.jsonl" }, { sheet: 0, row: 0, column: 3 });
    expect(messages).toMatchObject({ format: "json", truncated: false });
    expect(JSON.parse(messages.text)).toEqual([{ role: "user", content: "hi" }]);
    expect(messages.text).toContain('\n  {\n    "role": "user"');
    const record = await readCell({ root, path: "l.jsonl" }, { sheet: 0, row: 0, column: null });
    expect(record).toMatchObject({ format: "json", truncated: true });
    expect(record.text.startsWith('{\n  "id": 1,\n  "output": "xxx')).toBe(true);
    expect(responseBytes(full)).toBeLessThan(MAX_RESPONSE_BYTES);
  });

  it("returns the text of an invalid line as its full value", async () => {
    const root = workspace({ "bad.jsonl": lines('{"a":1}', '{"a": nope}') });
    const full = await readCell({ root, path: "bad.jsonl" }, { sheet: 0, row: 1, column: 0 });
    expect(full).toMatchObject({ text: '{"a": nope}', format: "text", line: 2 });
  });

  it("finds text in flattened columns and resumes across calls", async () => {
    const root = workspace({ "s.jsonl": evalRecords(600) });
    const first = await searchDocument({ root, path: "s.jsonl" }, "model-a");
    expect(first.matches).toHaveLength(50);
    expect(first.matches[0]!.target).toEqual({ type: "cell", sheet: 0, row: 1, column: 5 });
    let cursor = first.next;
    let total = first.matches.length;
    while (cursor) {
      const next = await searchDocument({ root, path: "s.jsonl" }, "model-a", cursor);
      total += next.matches.length;
      cursor = next.next;
    }
    expect(total).toBe(300);
  });
});
