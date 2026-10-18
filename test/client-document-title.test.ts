import { describe, expect, it } from "vitest";
import { documentTitle } from "../client/format";

describe("document screen title", () => {
  it("tells apart files that share a name by their folder", () => {
    expect(documentTitle({ path: "runs/2026-10-17-rag-eval/report.pdf" })).toBe("report.pdf · runs/2026-10-17-rag-eval");
    expect(documentTitle({ path: "runs/2026-10-17-rag-eval-v2/report.pdf" })).toBe("report.pdf · runs/2026-10-17-rag-eval-v2");
  });

  it("shows only the name at the workspace root and a placeholder without a path", () => {
    expect(documentTitle({ path: "report.pdf" })).toBe("report.pdf");
    expect(documentTitle({})).toBe("Document");
  });

  it("keeps the end of a long folder, the part nearest the file", () => {
    const title = documentTitle({ path: "very/deep/folder/structure/that/goes/on/and/on/run-42/report.pdf" });
    expect(title).toBe("report.pdf · …er/structure/that/goes/on/and/on/run-42");
    expect(title.length).toBe("report.pdf · ".length + 40);
  });
});
