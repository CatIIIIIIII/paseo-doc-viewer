import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { scannedDocuments } from "../server/recent";
import { createTurnDocs, type TurnDocsHost } from "../server/turn-docs";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function workspace() {
  const root = mkdtempSync(join(tmpdir(), "turn-docs-folders-"));
  roots.push(root);
  const write = (path: string, text = "%PDF-1.4") => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  };
  return { root, write };
}

const agent = { id: "agent-1", workspaceId: "wks_1", parentAgentId: null, provider: "fake", cwd: "/ws", title: null };

async function turn(root: string, during: () => void) {
  const service = createTurnDocs({ scan: scannedDocuments, enabled: async () => true, log: () => {} });
  const host: TurnDocsHost = { resolveRoot: async () => root, append: async () => {} };
  service.turnStarted({ agent, turnId: "t1" }, host);
  await new Promise((resolve) => setTimeout(resolve, 50));
  during();
  return service.turnEnded({ agent, turnId: "t1", outcome: { kind: "completed" }, timeline: [] }, host);
}

describe("turn card folder rows on a real workspace", () => {
  it("folds a new worktree and a new submodule, lists new files of existing repos, and skips a deleted repo", async () => {
    const { root, write } = workspace();
    write("proj/.git/HEAD", "ref: refs/heads/main");
    write("proj/old.pdf");
    write("gone/.git/HEAD", "ref: refs/heads/main");
    write("gone/a.pdf");
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    const row = await turn(root, () => {
      write("proj-gallery/.git", "gitdir: ../proj/.git/worktrees/proj-gallery");
      for (let index = 0; index < 20; index++) write(`proj-gallery/assets/shot-${index}.pdf`);
      write("proj/deps/lib/.git", "gitdir: ../../.git/modules/lib");
      write("proj/deps/lib/manual.pdf");
      write("proj/report.pdf");
      write("notes.pdf");
      rmSync(join(root, "gone"), { recursive: true });
    });
    expect(row!.version).toBe(2);
    expect(row!.data.files.map((file) => file.path).sort()).toEqual(["notes.pdf", "proj/report.pdf"]);
    const groups = row!.data.groups.map(({ reason, path, count, files }) => ({ reason, path, count, shown: files.length }));
    expect(groups.sort((a, b) => a.path.localeCompare(b.path))).toEqual([
      { reason: "checkout", path: "proj-gallery", count: 20, shown: 12 },
      { reason: "checkout", path: "proj/deps/lib", count: 1, shown: 1 },
    ]);
    expect(row!.data.moreCount).toBe(0);
  });

  it("folds a new folder with 13 files and lists one with 12", async () => {
    const { root, write } = workspace();
    write("old.pdf");
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    const row = await turn(root, () => {
      for (let index = 0; index < 12; index++) write(`twelve/f-${index}.pdf`);
      for (let index = 0; index < 13; index++) write(`thirteen/sub/f-${index}.pdf`);
    });
    expect(row!.data.files).toHaveLength(11);
    expect(row!.data.moreCount).toBe(1);
    expect(row!.data.files.every((file) => file.path.startsWith("twelve/"))).toBe(true);
    expect(row!.data.groups.map(({ reason, path, count }) => ({ reason, path, count }))).toEqual([{ reason: "folder", path: "thirteen", count: 13 }]);
  });
});
