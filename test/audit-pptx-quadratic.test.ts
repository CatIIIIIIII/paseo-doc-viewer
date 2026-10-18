import { describe, expect, it } from "vitest";
import { openDocument, renderPage } from "../server/documents";
import { workspace } from "./helpers";
import { pptxEntries, rawZip, type RawEntry } from "./zip-builder";

// Reflection probe (2026-10-17): pptx.ts runs whole-part regexes whose `[\s\S]*?` body or `[^>]*`
// start tag scans to the end of the part once per candidate, so a slide, presentation.xml or rels
// part of unclosed tags is O(n^2). Scratch probe of the bare patterns at 32/64/128 KiB:
// "<a:p " 152/585/2380 ms, "<a:t " inside one paragraph 168/657/2608 ms, "<p:sldId " 127/504/1977
// ms, unclosed "<a:p>" 30/101/406 ms. Parts may unpack to 32 MiB (OFFICE_LIMITS.maxPartBytes) from
// a few KiB of deflate, which blocks the plugin for hours while every RPC times out.
// The old PARAGRAPH pattern also dropped the text of `<a:p >`; the last test covers that.

const KiB = 1024;
const repeat = (unit: string, bytes: number) => unit.repeat(Math.floor(bytes / unit.length));

function replaced(entries: RawEntry[], name: string, data: string): RawEntry[] {
  return entries.map((entry) => (entry.name === name ? { name, data } : entry));
}

async function stall(entries: RawEntry[]): Promise<number> {
  const root = workspace({ "deck.pptx": rawZip(entries) });
  let maxLag = 0;
  let last = performance.now();
  const probe = setInterval(() => {
    const now = performance.now();
    maxLag = Math.max(maxLag, now - last);
    last = now;
  }, 10);
  try {
    await openDocument({ root, path: "deck.pptx" }).catch(() => {});
    await renderPage({ root, path: "deck.pptx" }, { index: 0 }).catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 20));
  } finally {
    clearInterval(probe);
  }
  return maxLag;
}

describe("audit: pptx text extraction is quadratic on unclosed tags", () => {
  it.fails("reads a slide of unclosed paragraphs without a long stall", async () => {
    expect(await stall(pptxEntries([repeat("<a:p>", 384 * KiB)]))).toBeLessThan(1000);
  }, 60_000);

  it.fails("reads a slide of paragraph start tags that never end without a long stall", async () => {
    expect(await stall(pptxEntries([repeat("<a:p ", 160 * KiB)]))).toBeLessThan(1000);
  }, 60_000);

  it.fails("reads a paragraph full of unclosed text runs and breaks without a long stall", async () => {
    expect(await stall(pptxEntries([`<a:p>${repeat("<a:t ", 128 * KiB)}${repeat("<a:br ", 128 * KiB)}</a:p>`]))).toBeLessThan(1000);
  }, 60_000);

  it.fails("reads a slide of unclosed picture tags without a long stall", async () => {
    expect(await stall(pptxEntries([repeat("<a:blip ", 384 * KiB)]))).toBeLessThan(1000);
  }, 60_000);

  it.fails("opens a presentation of unclosed slide ids without a long stall", async () => {
    const xml = `<p:presentation><p:sldIdLst>${repeat("<p:sldId ", 160 * KiB)}</p:sldIdLst></p:presentation>`;
    expect(await stall(replaced(pptxEntries(["x"]), "ppt/presentation.xml", xml))).toBeLessThan(1000);
  }, 60_000);

  it.fails("opens a presentation whose relationships never close without a long stall", async () => {
    const xml = `<Relationships>${repeat("<Relationship ", 384 * KiB)}`;
    expect(await stall(replaced(pptxEntries(["x"]), "ppt/_rels/presentation.xml.rels", xml))).toBeLessThan(1000);
  }, 60_000);

  it.fails("reads well-formed slide text, including a paragraph start tag with a trailing space", async () => {
    const body = [
      `<p:sp><p:txBody><a:p><a:pPr algn="ctr"/><a:r><a:rPr lang="en-US"/><a:t>Title &amp; more</a:t></a:r></a:p>`,
      `<a:p/><a:p lvl="1"><a:r><a:t xml:space="preserve">one</a:t></a:r><a:br/><a:r><a:t>two</a:t></a:r></a:p>`,
      `<a:p><a:endParaRPr/></a:p><a:p ><a:r><a:t>spaced</a:t></a:r></a:p></p:txBody></p:sp>`,
    ].join("");
    const root = workspace({ "deck.pptx": rawZip(pptxEntries([body])) });
    expect(await openDocument({ root, path: "deck.pptx" })).toMatchObject({ kind: "pptx", slideCount: 1 });
    const slide = await renderPage({ root, path: "deck.pptx" }, { index: 0 });
    if (slide.kind !== "pptx") throw new Error("expected pptx");
    expect(slide.texts).toEqual(["Title & more", "one\ntwo", "spaced"]);
  });
});
