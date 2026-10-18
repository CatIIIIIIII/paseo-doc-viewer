import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { stateDirectory, ViewerStateStore } from "../server/viewer-state";
import { pluginModule, runCapped } from "./capped-child";
import { workspace } from "./helpers";

const pos = (index: number) => ({ type: "page" as const, index, zoom: 1, text: false });
const keys = (dir: string) => Object.keys(JSON.parse(readFileSync(join(dir, "positions.json"), "utf8")).entries).sort();

// Audit (post 0.4.0): viewer-state.ts had one queue per process but no cross-process lock, and the
// default state dir was not scoped per Paseo home. Two daemons or app instances sharing it did
// read-modify-write on positions.json and silently clobbered each other. load() also discarded the
// whole file if it was corrupt or over 1 MiB, so the next write persisted an empty set. Writes now
// take a lock file and re-read under it, a large file is trimmed by last use, an unreadable one is
// kept aside, and a daemon with its own PASEO_HOME gets its own folder.

describe("audit: viewer state across processes", () => {
  it("scopes the default state directory to a non-default Paseo home", () => {
    const withHome = stateDirectory({ PASEO_HOME: "/tmp/home-a" } as NodeJS.ProcessEnv, "/tmp/user");
    const otherHome = stateDirectory({ PASEO_HOME: "/tmp/home-b" } as NodeJS.ProcessEnv, "/tmp/user");
    expect(withHome).not.toBe(otherHome);
    // The default home keeps the folder earlier versions used.
    const base = stateDirectory({} as NodeJS.ProcessEnv, "/tmp/user");
    expect(stateDirectory({ PASEO_HOME: "~/.paseo" } as NodeJS.ProcessEnv, "/tmp/user")).toBe(base);
    expect(stateDirectory({ PASEO_HOME: "/tmp/user/.paseo/" } as NodeJS.ProcessEnv, "/tmp/user")).toBe(base);
    expect(withHome.startsWith(join(base, "homes"))).toBe(true);
  });

  it("keeps concurrent writes from two stores on one directory", async () => {
    const dir = workspace();
    const a = new ViewerStateStore(dir);
    const b = new ViewerStateStore(dir);
    await Promise.all([a.write("A", pos(1)), b.write("B", pos(2))]);
    expect(keys(dir)).toEqual(["A", "B"]);
  });

  it("keeps saved marks when positions.json grows past 1 MiB", async () => {
    const dir = workspace();
    const store = new ViewerStateStore(dir);
    await store.write("keep1", pos(1));
    await store.write("keep2", pos(2));
    const data = JSON.parse(readFileSync(join(dir, "positions.json"), "utf8"));
    data.entries.bloat = { position: pos(1), filler: "x".repeat(1_100_000), touched: 1 };
    writeFileSync(join(dir, "positions.json"), JSON.stringify(data));
    await new ViewerStateStore(dir).write("new", pos(3));
    expect(keys(dir)).toEqual(expect.arrayContaining(["keep1", "keep2"]));
  });

  it("keeps concurrent writes from stores in separate processes", async () => {
    const dir = workspace();
    const script = (name: string) =>
      `import { ViewerStateStore } from ${pluginModule("server/viewer-state.ts")};
       const store = new ViewerStateStore(${JSON.stringify(dir)});
       await Promise.all(Array.from({ length: 20 }, (_, i) => store.write("${name}" + i, { type: "page", index: i, zoom: 1, text: false })));
       console.log("done");`;
    const results = await Promise.all(["P", "Q", "R"].map((name) => runCapped(script(name), [], 256)));
    for (const result of results) expect(result.stdout.trim()).toBe("done");
    expect(keys(dir)).toHaveLength(60);
  }, 60_000);

  it("trims an oversized file by last use instead of wiping it", async () => {
    const dir = workspace();
    const entries = Object.fromEntries(
      Array.from({ length: 450 }, (_, i) => [`k${i}`.padEnd(4_000, "x"), { position: pos(i), touched: 1_000 + i }]),
    );
    writeFileSync(join(dir, "positions.json"), JSON.stringify({ version: 1, entries }));
    await new ViewerStateStore(dir).write("new", pos(1));
    const saved = keys(dir);
    expect(saved).toContain("new");
    expect(saved).toContain("k449".padEnd(4_000, "x"));
    expect(saved).not.toContain("k0".padEnd(4_000, "x"));
    expect(statSync(join(dir, "positions.json")).size).toBeLessThanOrEqual(1024 * 1024);
  });

  it("keeps an unreadable file aside instead of overwriting it", async () => {
    const dir = workspace({ "positions.json": "{ not json" });
    await new ViewerStateStore(dir).write("new", pos(1));
    expect(readFileSync(join(dir, "positions.json.bad"), "utf8")).toBe("{ not json");
    expect(keys(dir)).toEqual(["new"]);
  });

  it("agrees on one secret when two stores create it at once", async () => {
    const dir = workspace();
    const stores = Array.from({ length: 8 }, () => new ViewerStateStore(dir));
    const makers = await Promise.all(stores.map((store) => store.scannedKeys("/root")));
    expect(new Set(makers.map((key) => key("a.pdf"))).size).toBe(1);
  });
});
