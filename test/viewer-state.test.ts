import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { stateDirectory, ViewerStateStore } from "../server/viewer-state";
import { workspace } from "./helpers";

const position = { type: "page" as const, index: 4, zoom: 2, text: true };
const posix = process.platform !== "win32";
describe("durable viewer positions", () => {
  it("survives reopening the store, serializes concurrent writes, and resets one file only", async () => {
    const directory = workspace();
    const store = new ViewerStateStore(directory);
    await Promise.all([store.write("one", position), store.write("two", { ...position, index: 9 })]);
    const reopened = new ViewerStateStore(directory);
    expect(await reopened.read("one")).toMatchObject({ position });
    await reopened.write("one", null);
    expect(await reopened.read("one")).toBeNull();
    expect(await reopened.read("two")).toMatchObject({ position: { index: 9 } });
    expect(JSON.parse(readFileSync(join(directory, "positions.json"), "utf8")).entries.two).toEqual({ position: { ...position, index: 9 }, touched: expect.any(Number) });
    if (posix) expect(statSync(join(directory, "positions.json")).mode & 0o777).toBe(0o600);
  });
  it("recovers from corrupt state, rejects invalid positions, and caps retention", async () => {
    const directory = workspace({ "positions.json": "broken" });
    const store = new ViewerStateStore(directory);
    expect(await store.read("one")).toBeNull();
    await expect(store.write("one", { ...position, zoom: 50 })).rejects.toThrow();
    const entries = Object.fromEntries(Array.from({ length: 505 }, (_, index) => [`key${index}`, { position, touched: index }]));
    writeFileSync(join(directory, "positions.json"), JSON.stringify({ version: 1, entries }));
    await store.write("newest", position);
    const saved = JSON.parse(readFileSync(join(directory, "positions.json"), "utf8"));
    expect(Object.keys(saved.entries)).toHaveLength(500);
    expect(saved.entries.key0).toBeUndefined();
    expect(saved.entries.newest.position).toEqual(position);
  });
  it("keeps state below the read budget instead of writing unreadable history", async () => {
    const directory = workspace();
    const entries = Object.fromEntries(Array.from({ length: 499 }, (_, index) => [`key${index}`.padEnd(2_100, "x"), { position, touched: index }]));
    while (Buffer.byteLength(JSON.stringify({ version: 1, entries })) > 1024 * 1024 - 100) delete entries[Object.keys(entries)[0]];
    writeFileSync(join(directory, "positions.json"), JSON.stringify({ version: 1, entries }));
    const store = new ViewerStateStore(directory);
    await store.write("newest".padEnd(2_100, "y"), position);
    expect(statSync(join(directory, "positions.json")).size).toBeLessThanOrEqual(1024 * 1024);
    expect(await new ViewerStateStore(directory).read("newest".padEnd(2_100, "y"))).not.toBeNull();
  });
  it("canonicalizes file aliases and confines state keys to workspace paths", async () => {
    const root = workspace({ "file.pdf": "content" });
    const store = new ViewerStateStore(workspace());
    expect(await store.key(root, "./file.pdf")).toBe(await store.key(root, "file.pdf"));
    expect(await store.key(root, "file.pdf")).not.toContain("file.pdf");
    await expect(store.key(root, "../elsewhere")).rejects.toThrow(/outside/);
  });
  it("salts keys with a private per-install secret kept beside the state", async () => {
    const root = workspace({ "file.pdf": "content" });
    const directory = join(workspace(), "state");
    const store = new ViewerStateStore(directory);
    const key = await store.key(root, "file.pdf");
    expect(key).toBe(await new ViewerStateStore(directory).key(root, "file.pdf"));
    expect(key).not.toBe(await new ViewerStateStore(join(workspace(), "state")).key(root, "file.pdf"));
    expect(key).not.toBe(createHash("sha256").update(root).update("\0").update("file.pdf").digest("hex"));
    expect(readFileSync(join(directory, "secret"))).toHaveLength(32);
    if (posix) {
      expect(statSync(join(directory, "secret")).mode & 0o777).toBe(0o600);
      expect(statSync(directory).mode & 0o777).toBe(0o700);
    }
  });
  it.skipIf(!posix)("creates missing parent folders with ordinary permissions", async () => {
    const base = workspace();
    const store = new ViewerStateStore(join(base, "local", "state", "paseo-doc-viewer"));
    await store.write("one", position);
    mkdirSync(join(base, "reference"));
    expect(statSync(join(base, "local")).mode & 0o777).toBe(statSync(join(base, "reference")).mode & 0o777);
    expect(statSync(join(base, "local", "state", "paseo-doc-viewer")).mode & 0o777).toBe(0o700);
  });
  it("removes temporary files left by an interrupted write", async () => {
    const directory = workspace({ "positions-0123456789abcdef.tmp": "{}", "positions-fedcba9876543210.tmp": "{}", "notes.tmp": "" });
    const old = new Date(Date.now() - 10 * 60_000);
    utimesSync(join(directory, "positions-0123456789abcdef.tmp"), old, old);
    utimesSync(join(directory, "notes.tmp"), old, old);
    await new ViewerStateStore(directory).read("one");
    expect(existsSync(join(directory, "positions-0123456789abcdef.tmp"))).toBe(false);
    expect(existsSync(join(directory, "positions-fedcba9876543210.tmp"))).toBe(true);
    expect(existsSync(join(directory, "notes.tmp"))).toBe(true);
  });
  it("follows PASEO_DOC_VIEWER_STATE_DIR, then XDG_STATE_HOME, then ~/.local/state", () => {
    expect(stateDirectory({ PASEO_DOC_VIEWER_STATE_DIR: "/custom", XDG_STATE_HOME: "/xdg" }, "/home/me")).toBe("/custom");
    expect(stateDirectory({ XDG_STATE_HOME: "/xdg" }, "/home/me")).toBe(join("/xdg", "paseo-doc-viewer"));
    expect(stateDirectory({ XDG_STATE_HOME: "relative", PASEO_DOC_VIEWER_STATE_DIR: "relative" }, "/home/me")).toBe(join("/home/me", ".local", "state", "paseo-doc-viewer"));
  });
});
