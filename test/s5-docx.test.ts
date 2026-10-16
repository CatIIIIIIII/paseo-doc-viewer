import { describe, expect, it } from "vitest";
import { openDocument, readBlocks } from "../server/documents";
import type { DocBlock } from "../shared/rpc";
import { decodePng, workspaceWithFixtures } from "./helpers";

async function allBlocks(root: string, path: string): Promise<DocBlock[]> {
  const blocks: DocBlock[] = [];
  let cursor: number | null = 0;
  for (let guard = 0; cursor !== null && guard < 50; guard++) {
    const page = await readBlocks({ root, path }, { cursor });
    blocks.push(...page.blocks);
    cursor = page.nextCursor;
  }
  return blocks;
}

describe("S5: docx renders as readable blocks", () => {
  it("S5: contract.docx yields headings, paragraphs, lists, and a table in document order", async () => {
    const root = workspaceWithFixtures("contract.docx");
    expect(await openDocument({ root, path: "contract.docx" })).toMatchObject({ kind: "docx" });
    const blocks = await allBlocks(root, "contract.docx");

    expect(blocks[0]).toEqual({ type: "heading", level: 1, text: "Consulting Agreement" });
    expect(blocks).toContainEqual({ type: "heading", level: 3, text: "1.1 Working arrangements" });
    expect(blocks).toContainEqual({
      type: "list",
      ordered: false,
      items: ["Remote by default", "On site by agreement", "Equipment supplied by the Client"],
    });
    expect(blocks).toContainEqual({
      type: "list",
      ordered: true,
      items: ["This agreement", "Schedule A", "Any purchase order"],
    });
    const table = blocks.find((block) => block.type === "table");
    expect(table).toEqual({
      type: "table",
      rows: [
        ["Item", "Rate", "Unit"],
        ["Standard day", "550", "per day"],
        ["Out of hours", "700", "per day"],
        ["Travel & expenses", "at cost", "per claim"],
      ],
    });
    expect(blocks.at(-1)).toEqual({ type: "paragraph", text: "Either party may terminate on 30 days written notice." });
  });

  it("S5: a docx that is only a pasted screenshot yields an image block", async () => {
    const root = workspaceWithFixtures("scanned-report.docx");
    const blocks = await allBlocks(root, "scanned-report.docx");
    const image = blocks.find((block) => block.type === "image");
    if (!image || image.type !== "image") throw new Error("expected an image block");
    expect(image.image.mimeType).toBe("image/png");
    expect(decodePng(image.image.data)).toMatchObject({ width: image.image.width, height: image.image.height });
  });

  it("S5: a legacy .doc renamed to .docx fails with an unsupported-format error", async () => {
    const root = workspaceWithFixtures("legacy-format.docx");
    await expect(openDocument({ root, path: "legacy-format.docx" })).rejects.toThrow(/legacy|unsupported/i);
  });
});
