import { describe, expect, it } from "vitest";
import { createTurnDocs, type TurnDocsHost } from "../server/turn-docs";
import { turnDocsNote, turnDocsTitle } from "../client/turn-docs";
import {
  changedDuringTurn,
  TIMELINE_DATA_MAX_BYTES,
  TURN_DOCS_KIND,
  turnDocsRow,
  turnDocsRowId,
  turnDocsSchema,
  type ScannedFile,
  type TurnDocsFile,
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

describe("changedDuringTurn", () => {
  it("tells new from changed against the baseline and skips untouched files", () => {
    const baseline = { revisions: new Map([["report.pdf", "old"], ["same.pdf", "same"]]), complete: true };
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
    expect(statuses({ revisions: new Map(), complete: false })).toEqual(["new", "changed", "changed"]);
    expect(statuses(null)).toEqual(["new", "changed", "changed"]);
  });

  it("keeps files inside the slack before the start but not older ones", () => {
    const after = [file("edge.pdf", T0 - 500), file("before.pdf", T0 - 1_500)];
    expect(changedDuringTurn(after, { revisions: new Map(), complete: true }, T0).map((entry) => entry.path)).toEqual(["edge.pdf"]);
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

  it("has a stable id per turn and a kind the host accepts", () => {
    const row = turnDocsRow({ ...base, files: files(1) })!;
    expect(row).toMatchObject({ type: "plugin", id: `turn-docs:turn-7:${T0}`, kind: TURN_DOCS_KIND, version: 1 });
    expect(TURN_DOCS_KIND).toMatch(/^[a-z][a-z0-9-]*$/);
    expect(turnDocsRowId(null, T0)).toBe(`turn-docs:turn:${T0}`);
  });
});

describe("card labels", () => {
  it("says changed while the turn ran, not written by the agent", () => {
    expect(turnDocsTitle({ files: [{} as TurnDocsFile], moreCount: 0 })).toBe("1 document changed while this turn ran");
    expect(turnDocsTitle({ files: [{} as TurnDocsFile, {} as TurnDocsFile], moreCount: 3 })).toBe("5 documents changed while this turn ran");
    expect(turnDocsNote({ outcome: "completed", partial: false })).toBeNull();
    expect(turnDocsNote({ outcome: "canceled", partial: true })).toBe("Turn was stopped · Large workspace: only part of it was scanned");
  });
});

describe("createTurnDocs", () => {
  const agent = { id: "agent-1", workspaceId: "wks_1", parentAgentId: null, provider: "fake", cwd: "/ws", title: null };

  function harness({ before, after, enabled = true }: { before: ScannedFile[]; after: ScannedFile[]; enabled?: boolean }) {
    let clock = T0;
    const appended: unknown[] = [];
    const service = createTurnDocs({
      scan: async (_root, { fresh }) => ({ entries: fresh ? after : before, complete: true }),
      enabled: async () => enabled,
      now: () => clock,
      log: () => {},
    });
    const host: TurnDocsHost = { resolveRoot: async () => "/ws", append: async (_id, row) => appended.push(row) };
    return {
      appended,
      async turn(outcome: "completed" | "canceled" = "completed") {
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
    const service = createTurnDocs({ scan: async () => ({ entries: [file("a.pdf", T0 + 1)], complete: true }), enabled: async () => true, log: () => {} });
    expect(await service.turnEnded({ agent, turnId: "x", outcome: { kind: "completed" }, timeline: [] }, { resolveRoot: async () => "/ws", append: async () => {} })).toBeNull();
  });
});
