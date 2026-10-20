import { copyFileSync, statSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { revisionOf } from "../server/revision";
import { createTurnDocs, type TurnDocsHost } from "../server/turn-docs";
import { sharedOpenedMarks } from "../client/opened-marks";
import { listedFiles, TURN_GROUP, turnDocsNote, turnDocsTitle, turnFilePill } from "../client/turn-docs";
import { documentRevision } from "../shared/revision";
import { workspace } from "./helpers";
import {
  changedDuringTurn,
  groupChanges,
  TIMELINE_DATA_MAX_BYTES,
  TURN_DOCS_KIND,
  turnDocsRow,
  turnDocsRowId,
  turnDocsSchema,
  turnDocsV1Schema,
  upgradeTurnDocs,
  type Baseline,
  type ScannedFile,
  type ScannedFolders,
  type TurnDocsFile,
  type TurnDocsGroup,
} from "../shared/turn-docs";

const T0 = 1_000_000;
const file = (path: string, changedMs: number, revision = `r-${path}-${changedMs}`, extra: Partial<ScannedFile> = {}): ScannedFile => ({
  path,
  kind: path.endsWith(".xlsx") ? "xlsx" : "pdf",
  size: 10,
  revision,
  changedMs,
  ...extra,
});

const NO_FOLDERS = { dirs: new Map<string, number>(), repos: new Set<string>() };
const known = (revisions: [string, string][], complete = true, { dirs = [] as string[], repos = [] as string[] } = {}): Baseline =>
  ({ revisions: new Map(revisions), dirs: new Set(dirs), repos: new Set(repos), complete });

describe("changedDuringTurn", () => {
  it("tells new from changed against the baseline and skips untouched files", () => {
    const baseline = known([["report.pdf", "old"], ["same.pdf", "same"]]);
    const after = [
      file("report.pdf", T0 + 500, "new-rev"),
      file("out/data.xlsx", T0 + 900),
      file("same.pdf", T0 + 200, "same"),
      file("older.pdf", T0 - 60_000),
    ];
    expect(changedDuringTurn(after, baseline, T0).map(({ path, status }) => [path, status])).toEqual([
      ["out/data.xlsx", "new"],
      ["report.pdf", "changed"],
    ]);
  });

  it("falls back to birth time when the baseline is incomplete or missing", () => {
    const after = [file("a.pdf", T0 + 10, "x", { birthtimeMs: T0 + 5 }), file("b.pdf", T0 + 10, "y", { birthtimeMs: T0 - 99_000 }), file("c.pdf", T0 + 10, "z", { birthtimeMs: 0 })];
    const statuses = (baseline: Parameters<typeof changedDuringTurn>[1]) => changedDuringTurn(after, baseline, T0).map((entry) => entry.status);
    expect(statuses(known([], false))).toEqual(["new", "changed", "changed"]);
    expect(statuses(null)).toEqual(["new", "changed", "changed"]);
  });

  it("keeps files inside the slack before the start but not older ones", () => {
    const after = [file("edge.pdf", T0 - 500), file("before.pdf", T0 - 1_500)];
    expect(changedDuringTurn(after, known([]), T0).map((entry) => entry.path)).toEqual(["edge.pdf"]);
  });
});

describe("groupChanges", () => {
  const changed = (...paths: string[]): TurnDocsFile[] => paths.map((path) => ({ path, kind: "pdf", size: 1, revision: "r", status: "new" }));
  const edited = (...paths: string[]): TurnDocsFile[] => changed(...paths).map((entry) => ({ ...entry, status: "changed" }));
  const many = (dir: string, count: number) => Array.from({ length: count }, (_, index) => `${dir}/page-${index}.pdf`);
  const folders = (dirs: Record<string, number>, repos: string[] = []): ScannedFolders => ({ dirs: new Map(Object.entries(dirs)), repos: new Set(repos) });
  const summary = ({ files, groups }: ReturnType<typeof groupChanges>) =>
    ({ files: files.map((entry) => entry.path), groups: groups.map((group) => `${group.reason}:${group.path}:${group.count}`) });
  const born = T0 + 100;
  const old = T0 - 60_000;

  it("folds a new worktree, whose .git is a file, into one row and lists the rest", () => {
    const files = changed("docs/report.pdf", ...many("gallery", 40), "gallery/assets/shot.pdf", "metrics.pdf");
    const after = folders({ docs: old, gallery: born, "gallery/assets": born }, ["", "gallery"]);
    expect(summary(groupChanges(files, after, known([], true, { dirs: ["docs"], repos: [""] }), T0))).toEqual({
      files: ["docs/report.pdf", "metrics.pdf"],
      groups: ["checkout:gallery:41"],
    });
  });

  it("keeps listing new files of nested repos that existed, and never folds the workspace root", () => {
    const files = changed("proj/report.pdf", "proj/out/a.pdf", "root.pdf");
    const after = folders({ proj: 0, "proj/out": born }, ["", "proj"]);
    const result = groupChanges(files, after, known([], true, { dirs: ["proj"], repos: ["", "proj"] }), T0);
    expect(summary(result)).toEqual({ files: ["proj/report.pdf", "proj/out/a.pdf", "root.pdf"], groups: [] });
  });

  it("folds a new submodule of an existing repo, and a new checkout with its submodules as one row", () => {
    const files = changed("proj/lib/a.pdf", "proj/b.pdf", "clone/c.pdf", "clone/deps/sub/d.pdf");
    const after = folders({ proj: old, "proj/lib": born, clone: born, "clone/deps": born, "clone/deps/sub": born }, ["proj", "proj/lib", "clone", "clone/deps/sub"]);
    const baseline = known([], true, { dirs: ["proj"], repos: ["proj"] });
    expect(summary(groupChanges(files, after, baseline, T0))).toEqual({ files: ["proj/b.pdf"], groups: ["checkout:proj/lib:1", "checkout:clone:2"] });
  });

  it("folds a new folder past 12 changed files, counting its subfolders, and lists one with 12", () => {
    const files = changed(...many("twelve", 12), ...many("thirteen", 6), ...many("thirteen/deep", 7));
    const after = folders({ twelve: born, thirteen: born, "thirteen/deep": born });
    expect(summary(groupChanges(files, after, known([]), T0))).toEqual({ files: many("twelve", 12), groups: ["folder:thirteen:13"] });
  });

  it("with a partial baseline, trusts only birth times", () => {
    const files = changed("wt/a.pdf", "unknown/b.pdf");
    const after = folders({ wt: born, unknown: 0 }, ["wt", "unknown"]);
    expect(summary(groupChanges(files, after, known([], false), T0))).toEqual({ files: ["unknown/b.pdf"], groups: ["checkout:wt:1"] });
    expect(summary(groupChanges(files, after, null, T0))).toEqual({ files: ["unknown/b.pdf"], groups: ["checkout:wt:1"] });
  });

  it("with a complete baseline, folds no folder that existed, even one deleted and made again during the turn", () => {
    const files = changed(...many("out", 13), "again/a.pdf");
    const after = folders({ out: born, again: born }, ["again"]);
    const baseline = known([], true, { dirs: ["out", "again"], repos: ["again"] });
    expect(summary(groupChanges(files, after, baseline, T0))).toEqual({ files: [...many("out", 13), "again/a.pdf"], groups: [] });
  });

  it("lists the files of a repo initialized in a folder that existed", () => {
    const files = changed("init/b.pdf");
    const after = folders({ init: old }, ["init"]);
    expect(summary(groupChanges(files, after, known([], true, { dirs: ["init", "gone"], repos: ["gone"] }), T0))).toEqual({ files: ["init/b.pdf"], groups: [] });
    expect(summary(groupChanges(files, after, known([], false), T0))).toEqual({ files: ["init/b.pdf"], groups: [] });
  });

  it("never folds a changed file, even in a new checkout or folder", () => {
    const files = [...changed("wt/a.pdf", ...many("big", 13)), ...edited("wt/moved.pdf", "big/moved.pdf")];
    const after = folders({ wt: born, big: born }, ["wt"]);
    expect(summary(groupChanges(files, after, known([], false), T0))).toEqual({ files: ["wt/moved.pdf", "big/moved.pdf"], groups: ["checkout:wt:1", "folder:big:13"] });
  });

  it("adds nothing for a repo the turn deleted", () => {
    const files = changed("kept.pdf");
    const baseline = known([["gone/a.pdf", "r"]], true, { dirs: ["gone"], repos: ["gone"] });
    expect(summary(groupChanges(files, folders({}), baseline, T0))).toEqual({ files: ["kept.pdf"], groups: [] });
  });
});

describe("turnDocsRow", () => {
  const base = { workspaceId: "wks_1", turnId: "turn-7", startedAt: T0, endedAt: T0 + 5_000, outcome: "completed" as const, partial: false };
  const files = (count: number, pathLength = 10): TurnDocsFile[] =>
    Array.from({ length: count }, (_, index) => ({ path: `${String(index).padStart(pathLength, "d")}.pdf`, kind: "pdf", size: 1, revision: "r", status: "new" }));

  it("returns null when nothing changed", () => {
    expect(turnDocsRow({ ...base, files: [] })).toBeNull();
  });

  it("caps at 12 files and counts the rest", () => {
    const row = turnDocsRow({ ...base, files: files(15) })!;
    expect(row.data.files).toHaveLength(12);
    expect(row.data.moreCount).toBe(3);
    expect(turnDocsSchema.parse(row.data)).toEqual(row.data);
  });

  it("drops files until the data fits the daemon's 64 KiB limit", () => {
    const row = turnDocsRow({ ...base, files: files(12, 8_000) })!;
    const bytes = new TextEncoder().encode(JSON.stringify(row.data)).length;
    expect(bytes).toBeLessThanOrEqual(TIMELINE_DATA_MAX_BYTES);
    expect(row.data.files.length).toBeLessThan(12);
    expect(row.data.files.length + row.data.moreCount).toBe(12);
  });

  const group = (path: string, count: number, pathLength = 10): TurnDocsGroup =>
    ({ reason: "checkout", path, count, files: files(count, pathLength).map((entry) => ({ ...entry, path: `${path}/${entry.path}` })) });

  it("shows folder rows with the first 12 of their files, and keeps every file in the title count", () => {
    const row = turnDocsRow({ ...base, files: files(2), groups: [group("gallery", 65)] })!;
    expect(row.data.files).toHaveLength(2);
    expect(row.data.groups).toMatchObject([{ path: "gallery", count: 65 }]);
    expect(row.data.groups[0]!.files).toHaveLength(12);
    expect(row.data.moreCount).toBe(0);
    expect(turnDocsTitle(row.data)).toBe("67 documents changed while this turn ran");
    expect(turnDocsSchema.parse(row.data)).toEqual(row.data);
    expect(turnDocsRow({ ...base, files: [], groups: [group("gallery", 3)] })!.data.files).toEqual([]);
  });

  it("shares the 12 rows between folder rows and files", () => {
    const row = turnDocsRow({ ...base, files: files(15), groups: [group("a", 20), group("b", 13), group("c", 1)] })!;
    expect(row.data.groups.map((entry) => entry.path)).toEqual(["a", "b", "c"]);
    expect(row.data.files).toHaveLength(9);
    expect(row.data.moreCount).toBe(6);
    expect(turnDocsTitle(row.data)).toBe("49 documents changed while this turn ran");
  });

  it("past 64 KiB drops a folder row's expanded files before listed files", () => {
    const row = turnDocsRow({ ...base, files: files(3, 3_000), groups: [group("a", 30, 3_000), group("b", 30, 3_000)] })!;
    expect(new TextEncoder().encode(JSON.stringify(row.data)).length).toBeLessThanOrEqual(TIMELINE_DATA_MAX_BYTES);
    expect(row.data.files).toHaveLength(3);
    expect(row.data.groups.map((entry) => entry.count)).toEqual([30, 30]);
    expect(row.data.groups[0]!.files.length + row.data.groups[1]!.files.length).toBeLessThan(24);
    expect(Math.abs(row.data.groups[0]!.files.length - row.data.groups[1]!.files.length)).toBeLessThanOrEqual(1);
    expect(turnDocsTitle(row.data)).toBe("63 documents changed while this turn ran");
  });

  it("keeps rows stored as version 1 readable", () => {
    const stored = { workspaceId: "wks_1", startedAt: T0, endedAt: T0 + 1, outcome: "completed", files: files(1), moreCount: 0, partial: false };
    expect(turnDocsSchema.safeParse(stored).success).toBe(false);
    expect(upgradeTurnDocs(turnDocsV1Schema.parse(stored))).toEqual({ ...stored, groups: [] });
  });

  it("has a stable id per turn and a kind the host accepts", () => {
    const row = turnDocsRow({ ...base, files: files(1) })!;
    expect(row).toMatchObject({ type: "plugin", id: `turn-docs:turn-7:${T0}`, kind: TURN_DOCS_KIND, version: 2 });
    expect(TURN_DOCS_KIND).toMatch(/^[a-z][a-z0-9-]*$/);
    expect(turnDocsRowId(null, T0)).toBe(`turn-docs:turn:${T0}`);
  });
});

describe("card labels", () => {
  it("says changed while the turn ran, not written by the agent", () => {
    expect(turnDocsTitle({ files: [{} as TurnDocsFile], groups: [], moreCount: 0 })).toBe("1 document changed while this turn ran");
    expect(turnDocsTitle({ files: [{} as TurnDocsFile, {} as TurnDocsFile], groups: [], moreCount: 3 })).toBe("5 documents changed while this turn ran");
    expect(turnDocsTitle({ files: [{} as TurnDocsFile], groups: [{ reason: "checkout", path: "wt", count: 65, files: [] }], moreCount: 1 }))
      .toBe("67 documents changed while this turn ran");
    expect(turnDocsNote({ outcome: "completed", partial: false })).toBeNull();
    expect(turnDocsNote({ outcome: "canceled", partial: true })).toBe("Turn was stopped · Large workspace: only part of it was scanned");
  });
});

describe("card folder rows", () => {
  const entry = (path: string): TurnDocsFile => ({ path, kind: "pdf", size: 1, revision: "r", status: "new" });
  const data = {
    files: [entry("a.pdf")],
    groups: [
      { reason: "checkout" as const, path: "wt", count: 65, files: [entry("wt/b.pdf"), entry("wt/c.pdf")] },
      { reason: "folder" as const, path: "out", count: 13, files: [entry("out/d.pdf")] },
    ],
  };

  it("lists, and so steps through, a folder row's files only once it is shown", () => {
    expect(listedFiles(data, new Set()).map((file) => file.path)).toEqual(["a.pdf"]);
    expect(listedFiles(data, new Set(["out"])).map((file) => file.path)).toEqual(["a.pdf", "out/d.pdf"]);
    expect(listedFiles(data, new Set(["out", "wt"])).map((file) => file.path)).toEqual(["a.pdf", "wt/b.pdf", "wt/c.pdf", "out/d.pdf"]);
  });

  it("says what the row stands for", () => {
    expect(TURN_GROUP.checkout.detail(65)).toBe("New checkout · 65 documents");
    expect(TURN_GROUP.checkout.detail(1)).toBe("New checkout · 1 document");
    expect(TURN_GROUP.folder.detail(13)).toBe("New folder · 13 documents");
  });
});

describe("card row pill", () => {
  const atTurn = documentRevision(100, T0, T0);
  const row = (status: "new" | "changed") => ({ status, revision: atTurn });

  it("keeps the turn's verdict until the file is opened at the card's revision or a later one", () => {
    expect(turnFilePill(row("new"), undefined)).toBe("new");
    expect(turnFilePill(row("changed"), undefined)).toBe("changed");
    expect(turnFilePill(row("new"), atTurn)).toBe("opened");
    expect(turnFilePill(row("changed"), documentRevision(120, T0 + 5_000, T0 + 5_000))).toBe("opened");
    expect(turnFilePill(row("new"), documentRevision(90, T0 - 5_000, T0 - 5_000))).toBe("new");
    expect(turnFilePill(row("changed"), "not a revision")).toBe("changed");
  });

  it("compares change times like the card does, so a copy keeping an old mtime is not taken as opened", () => {
    const openedBefore = documentRevision(90, T0 - 5_000, T0 - 5_000);
    const copiedOver = { status: "changed" as const, revision: documentRevision(100, T0 - 60_000, T0 + 10_000) };
    expect(turnFilePill(copiedOver, openedBefore)).toBe("changed");
    const openedCopyLater = documentRevision(100, T0 - 90_000, T0 + 20_000);
    expect(turnFilePill(row("new"), openedCopyLater)).toBe("opened");
    expect(turnFilePill(row("new"), documentRevision(100, T0 + 20_000, T0 - 90_000))).toBe("opened");
  });

  it("keeps the turn's verdict when two different revisions changed at the same time", () => {
    expect(turnFilePill(row("changed"), documentRevision(120, T0, T0))).toBe("changed");
    expect(turnFilePill({ status: "changed", revision: documentRevision(100, T0, T0 + 10) }, documentRevision(100, T0, T0))).toBe("changed");
    expect(turnFilePill(row("new"), documentRevision(100, T0, T0 + 1))).toBe("opened");
  });

  it("matches a real cp -p: the card says Changed and the row does not say Opened", () => {
    const root = workspace({ "report.pdf": "opened version", "backup.pdf": "older copy" });
    const report = join(root, "report.pdf");
    const past = new Date(Date.now() - 3_600_000);
    utimesSync(join(root, "backup.pdf"), past, past);
    const opened = revisionOf(statSync(report));
    const startedAt = Date.now();
    const baseline = known([["report.pdf", opened]]);
    copyFileSync(join(root, "backup.pdf"), report);
    utimesSync(report, past, past);
    const info = statSync(report);
    const after = { path: "report.pdf", kind: "pdf" as const, size: info.size, revision: revisionOf(info), changedMs: Math.max(info.mtimeMs, info.ctimeMs) };
    const [listed] = changedDuringTurn([after], baseline, startedAt);
    expect(listed).toMatchObject({ path: "report.pdf", status: "changed" });
    expect(turnFilePill(listed!, opened)).toBe("changed");
  });

  it("hears marks through one emitter per global object, and stops after unsubscribing", () => {
    const global = {};
    const marks = sharedOpenedMarks(global);
    expect(sharedOpenedMarks(global)).toBe(marks);
    expect(sharedOpenedMarks({})).not.toBe(marks);
    const heard: string[] = [];
    const stop = marks.subscribe((event) => heard.push(`${event.workspaceId}:${event.path}`));
    marks.notify({ workspaceId: "w", path: "a.pdf" });
    stop();
    marks.notify({ workspaceId: "w", path: "b.pdf" });
    expect(heard).toEqual(["w:a.pdf"]);
  });
});

describe("createTurnDocs", () => {
  const agent = { id: "agent-1", workspaceId: "wks_1", parentAgentId: null, provider: "fake", cwd: "/ws", title: null };

  function harness({ before, after, enabled = true }: { before: ScannedFile[]; after: ScannedFile[]; enabled?: boolean }) {
    let clock = T0;
    let scans: ScannedFile[][] = [];
    const appended: unknown[] = [];
    const service = createTurnDocs({
      scan: async () => ({ entries: scans.shift()!, complete: true, ...NO_FOLDERS }),
      enabled: async () => enabled,
      now: () => clock,
      log: () => {},
    });
    const host: TurnDocsHost = { resolveRoot: async () => "/ws", append: async (_id, row) => appended.push(row) };
    return {
      appended,
      async turn(outcome: "completed" | "canceled" = "completed") {
        scans = [before, after];
        service.turnStarted({ agent, turnId: "t1" }, host);
        clock += 4_000;
        const kind = outcome === "completed" ? { kind: "completed" as const } : { kind: "canceled" as const, reason: "user" };
        return service.turnEnded({ agent, turnId: "t1", outcome: kind, timeline: [] }, host);
      },
    };
  }

  it("appends one row listing new and changed documents", async () => {
    const h = harness({ before: [file("report.pdf", T0 - 60_000, "v1")], after: [file("report.pdf", T0 + 2_000, "v2"), file("data.xlsx", T0 + 3_000)] });
    const row = await h.turn();
    expect(h.appended).toEqual([row]);
    expect(row!.data.files.map(({ path, status }) => [path, status])).toEqual([["data.xlsx", "new"], ["report.pdf", "changed"]]);
  });

  it("adds no row for a chat-only turn, or a canceled turn that changed nothing", async () => {
    const same = [file("report.pdf", T0 - 60_000, "v1")];
    const h = harness({ before: same, after: same });
    expect(await h.turn()).toBeNull();
    expect(await h.turn("canceled")).toBeNull();
    expect(h.appended).toEqual([]);
  });

  it("still reports a canceled turn that changed files", async () => {
    const h = harness({ before: [], after: [file("a.pdf", T0 + 1_000)] });
    expect((await h.turn("canceled"))!.data.outcome).toBe("canceled");
  });

  it("respects the setting and needs a recorded start", async () => {
    const h = harness({ before: [], after: [file("a.pdf", T0 + 1_000)], enabled: false });
    expect(await h.turn()).toBeNull();
    const service = createTurnDocs({ scan: async () => ({ entries: [file("a.pdf", T0 + 1)], complete: true, ...NO_FOLDERS }), enabled: async () => true, log: () => {} });
    expect(await service.turnEnded({ agent, turnId: "x", outcome: { kind: "completed" }, timeline: [] }, { resolveRoot: async () => "/ws", append: async () => {} })).toBeNull();
  });
});
