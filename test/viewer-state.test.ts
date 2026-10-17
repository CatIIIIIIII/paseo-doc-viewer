import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { positionKey, ViewerStateStore } from "../server/viewer-state";
import { workspace } from "./helpers";

const position = { type: "page" as const, index: 4, zoom: 2, text: true };
describe("durable viewer positions", () => {
  it("survives reopening the store, serializes concurrent writes, and resets one file only", async () => {
    const directory = workspace();
    const store = new ViewerStateStore(directory);
    await Promise.all([store.write("one", "r1", position), store.write("two", "r2", { ...position, index: 9 })]);
    const reopened = new ViewerStateStore(directory);
    expect(await reopened.read("one")).toMatchObject({ revision: "r1", position });
    await reopened.write("one", "r1", null);
    expect(await reopened.read("one")).toBeNull();
    expect(await reopened.read("two")).toMatchObject({ position: { index: 9 } });
    if (process.platform !== "win32") expect(statSync(join(directory, "positions.json")).mode & 0o777).toBe(0o600);
  });
  it("recovers from corrupt state, rejects invalid positions, and caps retention", async () => {
    const directory = workspace({ "positions.json": "broken" });
    const store = new ViewerStateStore(directory);
    expect(await store.read("one")).toBeNull();
    await expect(store.write("one", "r", { ...position, zoom: 50 })).rejects.toThrow();
    const entries = Object.fromEntries(Array.from({ length: 505 }, (_, index) => [`key${index}`, { revision: "r", position, touched: index }]));
    writeFileSync(join(directory, "positions.json"), JSON.stringify({ version: 1, entries }));
    await store.write("newest", "r", position);
    const saved = JSON.parse(readFileSync(join(directory, "positions.json"), "utf8"));
    expect(Object.keys(saved.entries)).toHaveLength(500);
    expect(saved.entries.key0).toBeUndefined();
    expect(saved.entries.newest.position).toEqual(position);
  });
  it("keeps heavily escaped state below the read budget instead of writing unreadable history", async () => {
    const directory = workspace();
    const huge = { type: "grid", sheet: 0, sheetName: "\u0001".repeat(1024), rowOffset: 0, columnOffset: 0 };
    const entries = Object.fromEntries(Array.from({ length: 180 }, (_, index) => [`key${index}`, { revision: "r", position: huge, touched: index }]));
    // Seed just below the read limit; adding a large position must evict enough
    // entries for the next load to remain valid.
    while (Buffer.byteLength(JSON.stringify({ version: 1, entries })) > 1024 * 1024 - 1000) delete entries[Object.keys(entries)[0]];
    writeFileSync(join(directory, "positions.json"), JSON.stringify({ version: 1, entries }));
    const store = new ViewerStateStore(directory);
    await store.write("newest", "r", huge as any);
    expect(statSync(join(directory, "positions.json")).size).toBeLessThanOrEqual(1024 * 1024);
    expect(await new ViewerStateStore(directory).read("newest")).not.toBeNull();
  });
  it("canonicalizes file aliases and confines state keys to workspace paths", async () => {
    const root = workspace({ "file.pdf": "content" });
    expect(await positionKey(root, "./file.pdf")).toBe(await positionKey(root, "file.pdf"));
    expect(await positionKey(root, "file.pdf")).not.toContain("file.pdf");
    await expect(positionKey(root, "../elsewhere")).rejects.toThrow(/outside/);
  });
});
