import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { openDocument, renderPage } from "../server/documents";
import { FIXTURES, decodePng, workspaceWithFixtures } from "./helpers";

vi.mock("node:child_process", () => {
  const refuse = () => {
    throw new Error("S7 forbids external processes");
  };
  return { spawn: refuse, spawnSync: refuse, exec: refuse, execSync: refuse, execFile: refuse, execFileSync: refuse, fork: refuse };
});

async function slide(root: string, index: number) {
  const page = await renderPage({ root, path: "deck.pptx" }, { index });
  if (page.kind !== "pptx") throw new Error(`expected pptx slide, got ${page.kind}`);
  return page;
}

describe("S7: pptx slide strip without Office", () => {
  it("S7: deck.pptx reports its slide count", async () => {
    const root = workspaceWithFixtures("deck.pptx");
    expect(await openDocument({ root, path: "deck.pptx" })).toMatchObject({ kind: "pptx", slideCount: 11 });
  });

  it("S7: each slide carries its own text in presentation order, slide 10 after slide 9", async () => {
    const root = workspaceWithFixtures("deck.pptx");
    expect((await slide(root, 0)).texts).toEqual(["Slide 1", "Body text of slide 1"]);
    expect((await slide(root, 8)).texts).toEqual(["Slide 9", "Body text of slide 9"]);
    expect((await slide(root, 9)).texts).toEqual(["Slide 10", "Body text of slide 10"]);
  });

  it("S7: a slide with a picture returns that picture", async () => {
    const root = workspaceWithFixtures("deck.pptx");
    const second = await slide(root, 1);
    expect(second.images).toHaveLength(1);
    const original = decodePng(readFileSync(join(FIXTURES, "photo.png")).toString("base64"));
    expect(decodePng(second.images[0].data)).toMatchObject({ width: original.width, height: original.height });
    expect((await slide(root, 0)).images).toHaveLength(0);
  });
});
