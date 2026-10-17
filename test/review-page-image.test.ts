import { utimesSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openDocument, renderReviewPage } from "../server/documents";
import { REVIEW_IMAGE_MAX_BASE64_CHARS, REVIEW_IMAGE_MAX_EDGE_PX } from "../shared/limits";
import { decodePng, workspaceWithFixtures } from "./helpers";

describe("review page images", () => {
  it("renders a PDF page with both edges and the payload within the review bounds", async () => {
    const root = workspaceWithFixtures("statement.pdf", "huge-page.pdf");
    for (const path of ["statement.pdf", "huge-page.pdf"]) {
      const { revision } = await openDocument({ root, path });
      const page = await renderReviewPage({ root, path }, { index: 0, revision });
      expect(page.revision).toBe(revision);
      expect(Math.max(page.image.width, page.image.height)).toBeLessThanOrEqual(REVIEW_IMAGE_MAX_EDGE_PX);
      expect(page.image.data.length).toBeLessThanOrEqual(REVIEW_IMAGE_MAX_BASE64_CHARS);
      const png = decodePng(page.image.data);
      expect([png.width, png.height]).toEqual([page.image.width, page.image.height]);
    }
  }, 60_000);

  it("refuses to render a revision other than the one the note was written on", async () => {
    const root = workspaceWithFixtures("statement.pdf");
    const { revision } = await openDocument({ root, path: "statement.pdf" });
    utimesSync(join(root, "statement.pdf"), new Date(), new Date(Date.now() + 5_000));
    await expect(renderReviewPage({ root, path: "statement.pdf" }, { index: 0, revision })).rejects.toThrow(/changed/i);
  });

  it("is limited to PDF documents", async () => {
    const root = workspaceWithFixtures("photo.png");
    const { revision } = await openDocument({ root, path: "photo.png" });
    await expect(renderReviewPage({ root, path: "photo.png" }, { index: 0, revision })).rejects.toThrow(/not available/);
  });
});
