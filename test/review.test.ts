import { rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reviewStatus } from "../client/review";
import { listRecent, openDocument } from "../server/documents";
import { markReviewed, readViewerState, ViewerStateStore } from "../server/viewer-state";
import { filterEntries } from "../shared/browse";
import { docsRecentRpc, viewerStateReviewRpc } from "../shared/rpc";
import { workspace } from "./helpers";

beforeEach(() => vi.useFakeTimers({ toFake: ["Date"] }));
afterEach(() => vi.useRealTimers());

const later = () => vi.setSystemTime(Date.now() + 60_000);

function rewrite(root: string, path: string, content: string) {
  writeFileSync(join(root, path), content);
  const seconds = Date.now() / 1000 + 120;
  utimesSync(join(root, path), seconds, seconds);
  later();
}

describe("changed since explicitly reviewed", () => {
  it("records the displayed revision and time only when asked, keeps it beside positions, and survives a restart", async () => {
    const root = workspace({ "report.csv": "a,b\n1,2\n" });
    const directory = workspace();
    const store = new ViewerStateStore(directory);
    const { revision } = await openDocument({ root, path: "report.csv" });
    const key = await store.key(root, "report.csv");
    await store.write(key, { type: "grid", sheet: 0, rowOffset: 0, columnOffset: 0 });
    expect((await readViewerState(store, root, "report.csv")).review).toBeNull();
    expect(await markReviewed(store, root, "report.csv", revision)).toEqual({ review: { revision, at: Date.now() }, revision });
    await store.write(key, { type: "grid", sheet: 0, rowOffset: 40, columnOffset: 0 });
    expect((await readViewerState(new ViewerStateStore(directory), root, "report.csv")).review).toEqual({ revision, at: Date.now() });
  });

  it("refuses to mark a revision that is no longer the file's, keeping the earlier review", async () => {
    const root = workspace({ "report.csv": "a\n1\n" });
    const store = new ViewerStateStore(workspace());
    const first = (await openDocument({ root, path: "report.csv" })).revision;
    await markReviewed(store, root, "report.csv", first);
    rewrite(root, "report.csv", "a\n2\n3\n");
    const answer = await markReviewed(store, root, "report.csv", first);
    expect(answer.revision).not.toBe(first);
    expect(answer.review?.revision).toBe(first);
    expect((await markReviewed(store, root, "report.csv", null)).review).toBeNull();
    expect(await store.read(await store.key(root, "report.csv"))).toBeNull();
  });

  it("lists never-reviewed, reviewed and changed documents distinctly and filters to those needing review", async () => {
    const root = workspace({ "a.csv": "a\n", "b.csv": "b\n", "c.csv": "c\n", "d.pdf": "%PDF-1.4" });
    const store = new ViewerStateStore(workspace());
    for (const path of ["a.csv", "b.csv", "c.csv"]) await markReviewed(store, root, path, (await openDocument({ root, path })).revision);
    rewrite(root, "b.csv", "b\nchanged\n");
    rmSync(join(root, "c.csv"));
    const listed = await listRecent(root, {}, store);
    const status = Object.fromEntries(listed.entries.map((entry) => [entry.path, entry.review ?? "never"]));
    expect(status).toEqual({ "a.csv": "reviewed", "b.csv": "changed", "d.pdf": "never" });
    expect(listed.needsReview).toBe(1);
    const needing = await listRecent(root, { needsReview: true }, store);
    expect(needing.entries.map((entry) => entry.path)).toEqual(["b.csv"]);
    expect((await listRecent(root, { needsReview: true, group: "pdf" }, store)).entries).toEqual([]);
    expect(filterEntries(listed.entries, { needsReview: true }).map((entry) => entry.path)).toEqual(["b.csv"]);
  });

  it("ignores reading positions: saving a viewport never marks a document reviewed", async () => {
    const root = workspace({ "a.csv": "a\n" });
    const store = new ViewerStateStore(workspace());
    await store.write(await store.key(root, "a.csv"), { type: "grid", sheet: 0, rowOffset: 10, columnOffset: 0 });
    expect((await listRecent(root, {}, store)).entries[0]).not.toHaveProperty("review");
    expect((await readViewerState(store, root, "a.csv")).review).toBeNull();
  });

  it("validates the review input and filter at the RPC boundary", () => {
    expect(viewerStateReviewRpc.input.safeParse({ workspaceId: "w", path: "a.pdf", revision: "r1" }).success).toBe(true);
    expect(viewerStateReviewRpc.input.safeParse({ workspaceId: "w", path: "a.pdf", revision: null }).success).toBe(true);
    expect(viewerStateReviewRpc.input.safeParse({ workspaceId: "w", path: "a.pdf", revision: "" }).success).toBe(false);
    expect(docsRecentRpc.input.safeParse({ workspaceId: "w", needsReview: true }).success).toBe(true);
  });

  it("describes the marker for the displayed revision", () => {
    expect(reviewStatus(null, "r1")).toBe("never");
    expect(reviewStatus({ revision: "r1", at: 1 }, "r1")).toBe("reviewed");
    expect(reviewStatus({ revision: "r1", at: 1 }, "r2")).toBe("changed");
  });
});
