import { PDFDocument, StandardFonts } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { searchDocument, readPageText } from "../server/documents";
import { workspace } from "./helpers";

async function makePdf(): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const first = pdf.addPage([595, 842]);
  first.drawText("apple banana cherry", { font, x: 50, y: 700, size: 12 });
  first.drawText("nothing else here", { font, x: 50, y: 600, size: 12 });
  const second = pdf.addPage([595, 842]);
  second.drawText("one banana two banana", { font, x: 50, y: 700, size: 12 });
  return Buffer.from(await pdf.save());
}

describe("PDF search highlight boxes", () => {
  it("returns a normalized box per match on the rendered page", async () => {
    const root = workspace({ "bananas.pdf": await makePdf() });
    const result = await searchDocument({ root, path: "bananas.pdf" }, "banana");
    expect(result.next).toBeNull();
    expect(result.matches).toHaveLength(3);
    expect(result.matches.map((match) => match.target)).toEqual([
      { type: "page", index: 0 },
      { type: "page", index: 1 },
      { type: "page", index: 1 },
    ]);
    for (const match of result.matches) {
      expect(match.snippet.toLowerCase()).toContain("banana");
      expect(match.boxes?.length).toBeGreaterThan(0);
      for (const box of match.boxes ?? []) {
        expect(box.width).toBeGreaterThan(0);
        expect(box.height).toBeGreaterThan(0);
        for (const value of [box.x, box.y, box.width, box.height]) {
          expect(value).toBeGreaterThanOrEqual(0);
          expect(value).toBeLessThanOrEqual(1);
        }
      }
    }
    const [firstPage, earlier, later] = result.matches;
    // the word starts at x=50pt on a 595pt page, around y=700 of 842pt measured from the bottom
    expect(firstPage!.boxes![0]!.x).toBeGreaterThan(0.05);
    expect(firstPage!.boxes![0]!.x).toBeLessThan(0.5);
    expect(firstPage!.boxes![0]!.y).toBeGreaterThan(0.08);
    expect(firstPage!.boxes![0]!.y).toBeLessThan(0.25);
    // the two matches on page 2 sit on the same line, the second further right
    expect(Math.abs(earlier!.boxes![0]!.y - later!.boxes![0]!.y)).toBeLessThan(0.01);
    expect(later!.boxes![0]!.x).toBeGreaterThan(earlier!.boxes![0]!.x);
  });

  it("keeps match offsets aligned with the text the page text RPC shows", async () => {
    const root = workspace({ "bananas.pdf": await makePdf() });
    const result = await searchDocument({ root, path: "bananas.pdf" }, "banana");
    for (const match of result.matches) {
      if (match.target.type !== "page") continue;
      const page = await readPageText({ root, path: "bananas.pdf" }, { index: match.target.index });
      expect(page.text.slice(match.start, match.start + match.length).toLowerCase()).toBe("banana");
    }
  });

});
