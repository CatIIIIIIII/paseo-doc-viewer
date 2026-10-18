import { readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createVisitMemory, VISIT_REUSE_MS } from "../client/visits";
import { listRecent, openDocument } from "../server/documents";
import { forgetScan } from "../server/recent";
import { markReviewed, ViewerStateStore } from "../server/viewer-state";
import { VisitStore } from "../server/visits";
import { filterEntries } from "../shared/browse";
import { docsRecentRpc, docsVisitRpc } from "../shared/rpc";
import { workspace } from "./helpers";

const at = (root: string, path: string, ms: number) => utimesSync(join(root, path), ms / 1000, ms / 1000);

describe("new since the last Documents visit", () => {
  it("marks files changed after the visit and never reviewed, counts them and filters to them", async () => {
    const visit = Date.now() - 60_000;
    const root = workspace({ "old.pdf": "%PDF-1.4", "fresh.csv": "a\n", "reviewed.csv": "b\n", "changed.csv": "c\n" });
    // A status change also counts, so only set times well before the visit for the old file.
    const store = new ViewerStateStore(workspace());
    for (const path of ["reviewed.csv", "changed.csv"]) await markReviewed(store, root, path, (await openDocument({ root, path })).revision);
    writeFileSync(join(root, "changed.csv"), "c\nchanged\n");
    forgetScan(root);
    const listed = await listRecent(root, { newSince: visit }, store);
    const status = Object.fromEntries(listed.entries.map((entry) => [entry.path, entry.isNew ? "new" : entry.review ?? "never"]));
    // Every file here was created after the visit; reviewed ones are not new, whatever their state.
    expect(status).toEqual({ "old.pdf": "new", "fresh.csv": "new", "reviewed.csv": "reviewed", "changed.csv": "changed" });
    expect(listed.newCount).toBe(2);
    const later = await listRecent(root, { newSince: Date.now() + 60_000 }, store);
    expect(later.newCount).toBe(0);
    expect(later.entries.some((entry) => "isNew" in entry)).toBe(false);
    const only = await listRecent(root, { newSince: visit, newOnly: true, group: "excel" }, store);
    expect(only.entries.map((entry) => entry.path)).toEqual(["fresh.csv"]);
    expect(filterEntries(listed.entries, { newOnly: true }).map((entry) => entry.path).sort()).toEqual(["fresh.csv", "old.pdf"]);
  });

  it("counts nothing as new without a previous visit, and works with no review marks at all", async () => {
    const root = workspace({ "a.pdf": "%PDF-1.4" });
    const store = new ViewerStateStore(workspace());
    const first = await listRecent(root, {}, store);
    expect(first.newCount).toBe(0);
    expect(first.entries[0]).not.toHaveProperty("isNew");
    at(root, "a.pdf", Date.now() - 3_600_000);
    forgetScan(root);
    expect((await listRecent(root, { newSince: Date.now() - 60_000 }, store)).newCount).toBe(1);
  });

  it("records visits per workspace on disk, returning the previous one", async () => {
    const directory = workspace();
    const keyOf = async (root: string) => `k:${root}`;
    const visits = new VisitStore(directory, keyOf);
    expect(await visits.visit("/a", 1000)).toBeNull();
    expect(await visits.visit("/b", 1500)).toBeNull();
    expect(await visits.visit("/a", 2000)).toBe(1000);
    expect(await new VisitStore(directory, keyOf).visit("/a", 3000)).toBe(2000);
    // Only the caller's keys are stored (salted roots in the plugin), never the roots themselves.
    expect(Object.keys(JSON.parse(readFileSync(join(directory, "visits.json"), "utf8")).visits).sort()).toEqual(["k:/a", "k:/b"]);
    writeFileSync(join(directory, "visits.json"), "not json");
    expect(await visits.visit("/a", 4000)).toBeNull();
  });

  it("reuses a recent visit in the app, so switching workspaces does not reset what is new", async () => {
    let now = 10_000;
    const memory = createVisitMemory(() => now);
    const calls: string[] = [];
    const record = (since: number | null) => async () => {
      calls.push("visit");
      return since;
    };
    expect(memory.peek("ws")).toBeUndefined();
    const [a, b] = await Promise.all([memory.open("ws", record(500)), memory.open("ws", record(600))]);
    expect([a, b, calls.length]).toEqual([500, 500, 1]);
    now += VISIT_REUSE_MS - 1;
    expect(await memory.open("ws", record(700))).toBe(500);
    expect(memory.peek("ws")).toBe(500);
    now += 1;
    expect(memory.peek("ws")).toBeUndefined();
    expect(await memory.open("ws", record(9_000))).toBe(9_000);
    expect(calls.length).toBe(2);
    await expect(memory.open("other", async () => Promise.reject(new Error("offline")))).rejects.toThrow("offline");
    expect(memory.peek("other")).toBeUndefined();
  });

  it("validates the new filter and visit at the RPC boundary", () => {
    expect(docsRecentRpc.input.safeParse({ workspaceId: "w", newSince: 1, newOnly: true }).success).toBe(true);
    expect(docsRecentRpc.input.safeParse({ workspaceId: "w", newSince: -1 }).success).toBe(false);
    expect(docsVisitRpc.output.safeParse({ since: null }).success).toBe(true);
  });
});
