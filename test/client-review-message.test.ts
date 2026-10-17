import { describe, expect, it } from "vitest";
import { formatReview, noteRevisionStatus } from "../client/review-message";
import { createReviewDrafts, pageImageKey } from "../client/review-draft";
import { documentRevision, revisionModifiedAt } from "../shared/revision";

const modified = Date.UTC(2026, 9, 17, 14, 2, 31, 250);
const current = documentRevision(52_000, modified, modified);
const previous = documentRevision(48_000, modified - 3_600_000, modified - 3_600_000);
const image = { mimeType: "image/png" as const, width: 1414, height: 2000, data: "iVBORw0KGgo" };

function sampleDraft() {
  const drafts = createReviewDrafts();
  const legend = drafts.addNote("ws", { path: "out/report.pdf", revision: current, page: 3, text: "Legend overlaps the axis" })!;
  drafts.addNote("ws", { path: "out/appendix.pdf", revision: "opaque", page: 0, text: "Typo in the heading" });
  drafts.addNote("ws", { path: "out/report.pdf", revision: previous, page: 1, text: "Title is too long" });
  drafts.addNote("ws", { path: "out/report.pdf", revision: current, page: 6, text: "Move this table\nonto its own page" });
  drafts.addNote("ws", { path: "out/report.pdf", revision: current, page: 0, text: "Cover is fine, but add the date" });
  drafts.attachImage("ws", pageImageKey(legend), image);
  return drafts.get("ws");
}

describe("review message", () => {
  it("round-trips the modified time encoded in a document revision", () => {
    expect(revisionModifiedAt(current)).toBe(modified);
    expect(revisionModifiedAt("opaque")).toBeNull();
  });

  it("marks a note as older once the file's displayed revision moves on", () => {
    const note = { path: "a.pdf", revision: previous, page: 0 };
    expect(noteRevisionStatus(note, previous)).toBe("current");
    expect(noteRevisionStatus(note, current)).toBe("older");
    expect(noteRevisionStatus(note, undefined)).toBe("unknown");
  });

  it("groups notes by file and revision, pages in order, older revisions after current ones", () => {
    const revisions = new Map([["out/report.pdf", current]]);
    const message = formatReview(sampleDraft(), (path) => revisions.get(path));
    expect(message.text).toBe(
      [
        "Review notes from the document viewer. Each note gives the file, the revision I was viewing and the page (numbered from 1).",
        "",
        `out/report.pdf, revision ${current} (modified 2026-10-17 14:02 UTC)`,
        "- Page 1: Cover is fine, but add the date",
        "- Page 4: Legend overlaps the axis [image 1]",
        "- Page 7: Move this table",
        "  onto its own page",
        "",
        `out/report.pdf, older revision ${previous} (modified 2026-10-17 13:02 UTC); the file has changed since these notes`,
        "- Page 2: Title is too long",
        "",
        "out/appendix.pdf, revision opaque",
        "- Page 1: Typo in the heading",
        "",
        "Attached images:",
        `1. out/report.pdf page 4, revision ${current}`,
      ].join("\n"),
    );
    expect(message.images).toEqual([{ data: image.data, mimeType: image.mimeType }]);
  });

  it("omits the image section when no page is attached", () => {
    const drafts = createReviewDrafts();
    drafts.addNote("ws", { path: "a.pdf", revision: current, page: 0, text: "Fine" });
    const message = formatReview(drafts.get("ws"), () => current);
    expect(message.text.endsWith("- Page 1: Fine")).toBe(true);
    expect(message.images).toEqual([]);
  });
});
