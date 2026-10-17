import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { stateDirectory, ViewerStateStore } from "../server/viewer-state";
import { workspace } from "./helpers";

const pos = (index: number) => ({ type: "page" as const, index, zoom: 1, text: false });
const keys = (dir: string) => Object.keys(JSON.parse(readFileSync(join(dir, "positions.json"), "utf8")).entries).sort();

// Audit (post 0.4.0): viewer-state.ts has one queue per process but no cross-process lock, and the
// default state dir is not scoped per Paseo home (stateDirectory ignores the daemon home, falling
// back to ~/.local/state/paseo-doc-viewer). Two daemons or app instances sharing it do read-modify
// -write on positions.json and silently clobber each other. load() also discards the whole file if
// it is corrupt or over 1 MiB, so the next write persists an empty set, wiping every saved mark.

describe("audit: viewer state across processes", () => {
  it("does not scope the default state directory to the Paseo home", () => {
    const withHome = stateDirectory({ PASEO_HOME: "/tmp/home-a" } as NodeJS.ProcessEnv, "/tmp/user");
    const otherHome = stateDirectory({ PASEO_HOME: "/tmp/home-b" } as NodeJS.ProcessEnv, "/tmp/user");
    expect(withHome).toBe(otherHome);
  });

  it.fails("keeps concurrent writes from two stores on one directory (currently loses one)", async () => {
    const dir = workspace();
    const a = new ViewerStateStore(dir);
    const b = new ViewerStateStore(dir);
    await Promise.all([a.write("A", pos(1)), b.write("B", pos(2))]);
    expect(keys(dir)).toEqual(["A", "B"]);
  });

  it.fails("keeps saved marks when positions.json grows past 1 MiB (currently wipes all)", async () => {
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
});
