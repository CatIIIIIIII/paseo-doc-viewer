import { build } from "esbuild";
import { chromium, expect } from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { once } from "node:events";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { inspectionWorkbook } from "../fixtures/generators.ts";
const directory = resolve("node_modules/.cache/viewer-browser");
await mkdir(directory, { recursive: true });
const pdf = await PDFDocument.create();
const font = await pdf.embedFont(StandardFonts.Helvetica);
for (let index = 0; index < 3; index++) pdf.addPage().drawText(`Searchable statement page ${index + 1}`, { font, x: 40, y: 700 });
await writeFile(`${directory}/searchable.pdf`, await pdf.save());
const long = await PDFDocument.create();
const longPage = long.addPage([600, 1400]);
for (let line = 0; line < 80; line++) longPage.drawText(line === 76 ? "The needle is on this line" : `Filler line ${line + 1}`, { font: await long.embedFont(StandardFonts.Helvetica), x: 40, y: 1380 - line * 17, size: 11 });
await writeFile(`${directory}/long.pdf`, await long.save());
const report = await PDFDocument.create();
const reportFont = await report.embedFont(StandardFonts.HelveticaBold);
for (let index = 0; index < 60; index++) {
  const sheet = report.addPage([612, 792]);
  sheet.drawText(`Section ${index + 1}`, { font: reportFont, x: 60, y: 700, size: 48 });
  if (index === 41) sheet.drawRectangle({ x: 60, y: 200, width: 480, height: 400, color: rgb(0.2, 0.4, 0.9) });
}
await writeFile(`${directory}/report.pdf`, await report.save());
const stateDirectory = await mkdtemp(resolve(tmpdir(), "viewer-browser-state-"));
await writeFile(`${directory}/forecast.xlsx`, await inspectionWorkbook());
const base = { bundle: true, jsx: "automatic", logLevel: "silent" };
await build({ ...base, entryPoints: ["test/browser/app.tsx"], outfile: `${directory}/app.js`, platform: "browser", alias: {
  "react-native": resolve("test/browser/native-shim.tsx"),
  "@getpaseo/plugin/client/react-native": resolve("test/browser/native-shim.tsx"),
  "@getpaseo/plugin/client": resolve("test/browser/plugin-shim.ts"),
} });
await build({ ...base, entryPoints: ["test/browser/server.ts"], outfile: `${directory}/server.cjs`, platform: "node", format: "cjs", external: ["@getpaseo/plugin", "zod"] });
const server = spawn(process.execPath, [`${directory}/server.cjs`], { stdio: ["ignore", "pipe", "inherit"], env: { ...process.env, PASEO_DOC_VIEWER_STATE_DIR: stateDirectory } });
let browser;
let page;
try {
  const output = await Promise.race([once(server.stdout, "data"), once(server, "exit").then(() => { throw new Error("Harness exited before listening"); })]);
  const { port, root } = JSON.parse(output[0].toString());
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_EXECUTABLE_PATH, args: ["--no-sandbox", "--disable-dev-shm-usage", "--no-zygote", "--single-process", "--disable-gpu", "--disable-software-rasterizer"] });
  page = await browser.newPage({ viewport: { width: 1100, height: 1000 }, acceptDownloads: true });
  const failures = [];
  page.on("pageerror", (error) => { failures.push(error.message); console.error("Browser error:", error.message); });
  await page.goto(`http://127.0.0.1:${port}`);
  await expect(page.getByRole("button", { name: "Next page", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Next page", exact: true }).click();
  await expect(page.getByText("2 / 3", { exact: true })).toBeVisible();
  // Desktop keeps compact 28 px controls.
  expect((await page.getByRole("button", { name: "Next page", exact: true }).boundingBox()).height).toBe(28);
  await page.getByRole("button", { name: "Zoom in", exact: true }).click();
  await expect(page.getByText("1.5x", { exact: true })).toBeVisible();
  // A click on the content must leave PageDown scrolling it, not a focus wrapper.
  const pageImage = page.getByRole("img").first();
  await pageImage.click();
  const scroller = async () => pageImage.evaluate((element) => {
    for (let node = element.parentElement; node; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (/auto|scroll/.test(style.overflowY) && node.scrollHeight > node.clientHeight) return node.scrollTop;
    }
    return null;
  });
  const before = await scroller();
  expect(before).not.toBeNull();
  await page.keyboard.press("PageDown");
  await expect.poll(scroller).toBeGreaterThan(before);
  await page.waitForTimeout(1200);
  await page.getByRole("button", { name: "Close viewer", exact: true }).click();
  await page.getByRole("button", { name: "Reopen viewer", exact: true }).click();
  await expect(page.getByText("2 / 3", { exact: true })).toBeVisible();
  await expect(page.getByText("1.5x", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Reset reading position", exact: true }).click();
  await expect(page.getByText("1 / 3", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Find in document", exact: true }).click();
  await page.getByRole("textbox", { name: "Find in document", exact: true }).fill("statement");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page.getByText("3 matches", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Next match", exact: true }).click();
  await expect(page.getByText("1 of 3", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Page 1: Searchable statement page 1", exact: true })).toHaveAttribute("aria-pressed", "true");
  // A PDF match with page boxes stays on the rendered page and highlights it there.
  await expect(page.getByRole("button", { name: "Show page text", exact: true })).toBeVisible();
  await expect(page.getByText("1 / 3", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Current match on page", { exact: true })).toHaveCount(1);
  await expect(page.getByLabel("Match on page", { exact: true })).toHaveCount(0);
  await page.screenshot({ path: `${directory}/pdf-find.png`, fullPage: true });
  await page.getByRole("button", { name: "Close find", exact: true }).click();
  await page.getByRole("button", { name: "Find in document", exact: true }).focus();
  await page.keyboard.press("Control+f");
  await expect(page.getByRole("textbox", { name: "Find in document", exact: true })).toBeFocused();
  await page.getByRole("button", { name: "invoices.xlsx", exact: true }).click();
  await page.getByRole("button", { name: "Invoices", exact: true }).click();
  await page.waitForTimeout(1200);
  await page.getByRole("button", { name: "Close viewer", exact: true }).click();
  await page.getByRole("button", { name: "Reopen viewer", exact: true }).click();
  await expect(page.getByRole("button", { name: "Invoices", exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Find in document", exact: true }).click();
  await page.getByRole("textbox", { name: "Find in document", exact: true }).fill("Northwind");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page.getByRole("button", { name: "Next match", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Next match", exact: true }).click();
  await expect(page.getByText("Invoices!B2", { exact: true })).toBeVisible();
  // The jump keeps column A in view when the match fits in the first columns.
  await expect(page.getByText(/^Columns 1-/)).toBeVisible();
  await page.getByRole("button", { name: "Close find", exact: true }).click();
  await page.getByRole("button", { name: "forecast.xlsx", exact: true }).click();
  await page.getByText("$165.00", { exact: true }).click();
  const inspector = page.getByLabel("Cell Summary!B8", { exact: true });
  await expect(inspector.getByText("=B7*1.1", { exact: true })).toBeVisible();
  await expect(inspector.getByText("165", { exact: true })).toBeVisible();
  await expect(inspector.getByText('"$"#,##0.00', { exact: true })).toBeVisible();
  await page.getByText("=SUM(D3:D10)", { exact: true }).click();
  await expect(page.getByLabel("Cell Summary!G3", { exact: true }).getByText("None saved", { exact: true })).toBeVisible();
  await page.screenshot({ path: `${directory}/sheet-inspector.png`, fullPage: true });
  await page.getByRole("button", { name: "Close cell", exact: true }).click();
  await page.getByRole("button", { name: "Records", exact: true }).click();
  await page.getByRole("button", { name: "Use row 2 as header", exact: true }).click();
  await expect(page.getByText("Record 1 of 8 (row 3)", { exact: true })).toBeVisible();
  await expect(page.getByText("Region · A", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Record row 3", { exact: true }).getByText("North", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Next record", exact: true }).click();
  await expect(page.getByLabel("Record row 4", { exact: true }).getByText("South", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Inspect Total", exact: true }).click();
  await expect(page.getByLabel("Cell Summary!D4", { exact: true }).getByText("=B4+C4", { exact: true })).toBeVisible();
  await page.screenshot({ path: `${directory}/sheet-record.png`, fullPage: true });
  await page.getByRole("button", { name: "Show in grid", exact: true }).click();
  await expect(page.getByText("Rows 4-10 of 10", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Check for issues", exact: true }).click();
  const issues = page.getByLabel("Sheet issues", { exact: true });
  await expect(issues.getByText("Inspected Summary rows 1-5. Paused at the row limit, before Summary row 6.", { exact: true })).toBeVisible();
  await expect(issues.getByText("1 error cell, 1 formula without a saved result", { exact: true })).toBeVisible();
  while (await issues.getByRole("button", { name: "Continue check", exact: true }).isVisible()) {
    await issues.getByRole("button", { name: "Continue check", exact: true }).click();
    await expect(issues.getByLabel("Loading")).toHaveCount(0);
  }
  await expect(issues.getByText("Inspected Summary rows 1-10, Wide rows 1-21.", { exact: true })).toBeVisible();
  await expect(issues.getByText("2 error cells, 3 formulas without a saved result", { exact: true })).toBeVisible();
  await issues.getByRole("button", { name: "Summary!D9: no saved result · =B9+C9", exact: true }).click();
  await expect(page.getByLabel("Cell Summary!D9", { exact: true }).getByText("None saved", { exact: true })).toBeVisible();
  await expect(page.getByText("Rows 9-10 of 10", { exact: true })).toBeVisible();
  await expect(issues.getByText("Issue 4 of 5", { exact: true })).toBeVisible();
  await issues.getByRole("button", { name: "Next issue", exact: true }).click();
  await expect(page.getByLabel("Cell Summary!D10", { exact: true }).getByText("=B10+C10", { exact: true })).toBeVisible();
  await issues.getByRole("button", { name: "Show list", exact: true }).click();
  await expect(issues.getByRole("button", { name: "Summary!E7: #REF!", exact: true })).toBeVisible();
  await page.screenshot({ path: `${directory}/sheet-issues.png`, fullPage: true });
  // Records keeps the chosen header row for the session, also after the document is reopened.
  await page.getByRole("button", { name: "invoices.xlsx", exact: true }).click();
  await page.getByRole("button", { name: "forecast.xlsx", exact: true }).click();
  await page.getByRole("button", { name: "Records", exact: true }).click();
  await expect(page.getByText(/^Record \d+ of 8 \(row \d+\)$/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Use row 2 as header", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "long.pdf", exact: true }).click();
  await page.getByRole("button", { name: "Find in document", exact: true }).click();
  await page.getByRole("textbox", { name: "Find in document", exact: true }).fill("needle");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await page.getByRole("button", { name: /^Page 1: / }).click();
  // Playwright scrolls the window to the match row before clicking; the viewer's own
  // scroll is what should bring the highlight into the visible scrollport.
  await page.evaluate(() => window.scrollTo(0, 0));
  await expect(page.getByLabel("Current match on page", { exact: true }).first()).toBeInViewport();
  await page.screenshot({ path: `${directory}/pdf-match.png`, fullPage: true });
  await page.waitForTimeout(1200);
  await page.getByRole("button", { name: "Close viewer", exact: true }).click();
  await page.getByRole("button", { name: "Reopen viewer", exact: true }).click();
  await expect(page.getByRole("button", { name: "Show page text", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "many.csv", exact: true }).click();
  await page.getByRole("button", { name: "Find in document", exact: true }).click();
  await page.getByRole("textbox", { name: "Find in document", exact: true }).fill("needle");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page.getByText("120 matches", { exact: true })).toBeVisible({ timeout: 15000 });
  await expect(page.getByRole("button", { name: "Search more", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "contract.docx", exact: true }).click();
  await page.getByRole("button", { name: "Find in document", exact: true }).click();
  await page.getByRole("textbox", { name: "Find in document", exact: true }).fill("services");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page.getByRole("button", { name: "Next match", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Next match", exact: true }).click();
  await expect(page.getByText("Reading from search match", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "broken.pdf", exact: true }).click();
  await page.getByRole("button", { name: "Download original", exact: true }).click();
  await expect(page.getByRole("link", { name: "Save original file", exact: true })).toBeVisible();
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("link", { name: "Save original file", exact: true }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("broken.pdf");
  expect(await readFile(await download.path(), "utf8")).toBe("original unsupported file");
  await page.getByRole("button", { name: ".env", exact: true }).click();
  await expect(page.getByText(/Unsupported file type/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Download original", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "tone.wav", exact: true }).click();
  await expect(page.locator("audio")).toBeVisible();
  const media = await page.locator("audio").evaluate(async (element) => {
    await element.play();
    await new Promise((resolve) => setTimeout(resolve, 150));
    const result = { currentTime: element.currentTime, duration: element.duration, muted: element.muted, error: element.error?.message };
    element.pause(); return result;
  });
  expect(media.currentTime).toBeGreaterThan(0);
  expect(media.duration).toBeCloseTo(1, 1); expect(media.muted).toBe(false); expect(media.error).toBeUndefined();
  await page.screenshot({ path: `${directory}/audio.png`, fullPage: true });
  await page.getByRole("button", { name: "audible.webm", exact: true }).click();
  await expect(page.locator("video")).toBeVisible();
  const video = await page.locator("video").evaluate(async (element) => {
    await element.play();
    await new Promise((resolve) => setTimeout(resolve, 150));
    const result = { time: element.currentTime, muted: element.muted, tracks: element.captureStream().getAudioTracks().length };
    element.pause(); return result;
  });
  expect(video.time).toBeGreaterThan(0); expect(video.muted).toBe(false); expect(video.tracks).toBe(1);
  // A slow media transfer shows feedback immediately and can be cancelled before its response arrives.
  const slowMedia = async (route) => {
    if (route.request().postDataJSON().method === "media.chunk") await new Promise((resolve) => setTimeout(resolve, 500));
    await route.continue().catch(() => {});
  };
  await page.route("**/rpc", slowMedia);
  await page.getByRole("button", { name: "animated.webp", exact: true }).click();
  await expect(page.getByRole("progressbar", { name: "Loading animation", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Cancel loading", exact: true }).click();
  await expect(page.getByRole("button", { name: "Load animation", exact: true })).toBeVisible();
  await page.waitForTimeout(650);
  await expect(page.getByRole("button", { name: "Load animation", exact: true })).toBeVisible();
  await expect(page.getByRole("img").first()).toBeVisible();
  await page.getByRole("button", { name: "clip.mp4", exact: true }).click();
  await expect(page.getByRole("progressbar", { name: "Loading video", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Cancel loading", exact: true }).click();
  await expect(page.getByRole("button", { name: /^Load video/ })).toBeVisible();
  await page.waitForTimeout(650);
  await expect(page.locator("video")).toHaveCount(0);
  await page.getByRole("button", { name: /^Load video/ }).click();
  await expect(page.getByRole("progressbar", { name: "Loading video", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "statement.pdf", exact: true }).click();
  await expect(page.getByRole("button", { name: "Next page", exact: true })).toBeVisible();
  await page.waitForTimeout(650);
  await expect(page.locator("video")).toHaveCount(0);
  await page.unroute("**/rpc", slowMedia);
  // Adversarial lifecycle checks: a late request must not populate a new query
  // or create a Save link after the user cancelled preparation.
  await page.getByRole("button", { name: "statement.pdf", exact: true }).click();
  await page.getByRole("button", { name: "Find in document", exact: true }).click();
  const delaySearch = async (route) => {
    if (route.request().postDataJSON().method === "doc.search") await new Promise((resolve) => setTimeout(resolve, 250));
    await route.continue().catch(() => {});
  };
  await page.route("**/rpc", delaySearch);
  await page.getByRole("textbox", { name: "Find in document", exact: true }).fill("statement");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await page.getByRole("textbox", { name: "Find in document", exact: true }).fill("no such phrase");
  // The stale burst spans several delayed RPCs; wait for all of them to land.
  await page.waitForTimeout(2000);
  await expect(page.getByRole("button", { name: /^Page \d+:/ })).toHaveCount(0);
  await expect(page.getByText("3 matches", { exact: true })).toHaveCount(0);
  await page.unroute("**/rpc", delaySearch);
  await page.getByRole("button", { name: "broken.pdf", exact: true }).click();
  const delayChunk = async (route) => {
    if (route.request().postDataJSON().method === "file.chunk") await new Promise((resolve) => setTimeout(resolve, 250));
    await route.continue().catch(() => {});
  };
  await page.route("**/rpc", delayChunk);
  await page.getByRole("button", { name: "Download original", exact: true }).click();
  await expect(page.getByLabel("Preparing original file", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.waitForTimeout(400);
  await expect(page.getByRole("link", { name: "Save original file", exact: true })).toHaveCount(0);
  await page.unroute("**/rpc", delayChunk);
  const delayPosition = async (route) => {
    if (route.request().postDataJSON().method === "viewer-state.read") await new Promise((resolve) => setTimeout(resolve, 1900));
    await route.continue().catch(() => {});
  };
  await page.route("**/rpc", delayPosition);
  const writes = [];
  const recordWrite = (request) => { if (request.url().endsWith("/rpc") && request.postDataJSON()?.method === "viewer-state.write") writes.push(request); };
  page.on("request", recordWrite);
  await page.getByRole("button", { name: "statement.pdf", exact: true }).click();
  await expect(page.getByRole("button", { name: "Next page", exact: true })).toBeVisible({ timeout: 3000 });
  await page.getByRole("button", { name: "Next page", exact: true }).click();
  await page.waitForTimeout(700);
  await expect(page.getByText("2 / 3", { exact: true })).toBeVisible();
  // After the read timed out, a late answer must not enable writes over unread history.
  await page.getByRole("button", { name: "Next page", exact: true }).click();
  await page.waitForTimeout(1300);
  expect(writes).toHaveLength(0);
  page.off("request", recordWrite);
  await page.unroute("**/rpc", delayPosition);
  const thumbnails = { requested: [], inFlight: 0, maxInFlight: 0 };
  const isThumbnail = (request) => request.url().endsWith("/rpc") && request.postDataJSON()?.method === "doc.thumbnail";
  page.on("request", (request) => { if (!isThumbnail(request)) return; thumbnails.requested.push(request.postDataJSON().input.index); thumbnails.maxInFlight = Math.max(thumbnails.maxInFlight, ++thumbnails.inFlight); });
  const settled = (request) => { if (isThumbnail(request)) thumbnails.inFlight--; };
  page.on("requestfinished", settled);
  page.on("requestfailed", settled);
  const slowThumbnails = async (route) => {
    if (route.request().postDataJSON().method === "doc.thumbnail") await new Promise((resolve) => setTimeout(resolve, 150));
    await route.continue().catch(() => {});
  };
  await page.route("**/rpc", slowThumbnails);
  await page.getByRole("button", { name: "report.pdf", exact: true }).click();
  await page.getByRole("button", { name: "Page map", exact: true }).click();
  await expect(page.getByRole("img", { name: "Page 1 thumbnail", exact: true })).toBeVisible();
  await expect(page.getByRole("img", { name: "Page 10 thumbnail", exact: true })).toBeVisible();
  await page.waitForTimeout(1500);
  expect(thumbnails.maxInFlight).toBeLessThanOrEqual(2);
  expect(new Set(thumbnails.requested).size).toBeLessThan(30);
  expect(thumbnails.requested).not.toContain(59);
  await page.screenshot({ path: `${directory}/page-map.png`, fullPage: true });
  await page.getByLabel("Page thumbnails", { exact: true }).evaluate((element) => { element.parentElement.parentElement.scrollTop = 1e6; });
  await expect(page.getByRole("img", { name: "Page 60 thumbnail", exact: true })).toBeVisible();
  expect(thumbnails.maxInFlight).toBeLessThanOrEqual(2);
  await page.getByRole("button", { name: "Open page 42", exact: true }).click();
  await expect(page.getByText("42 / 60", { exact: true })).toBeVisible();
  await expect(page.getByRole("img", { name: "Page 42", exact: true })).toBeVisible();
  // Desktop strip: previous and next hug the chips, and the current chip is shown.
  const lastChip = await page.getByRole("button", { name: "Page 60", exact: true }).boundingBox();
  const nextBox = await page.getByRole("button", { name: "Next page", exact: true }).boundingBox();
  expect(nextBox.x - (lastChip.x + lastChip.width)).toBeLessThanOrEqual(8);
  await expect(page.getByRole("button", { name: "Page 42", exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Page map", exact: true }).click();
  await page.getByRole("button", { name: "Pin page 42", exact: true }).click();
  await page.getByRole("textbox", { name: "Pin label", exact: true }).fill("Chart");
  await page.getByRole("button", { name: "Save pin", exact: true }).click();
  await expect(page.getByRole("button", { name: "Open pin: Page 42, Chart", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Open page 42, pinned", exact: true })).toBeVisible();
  await page.screenshot({ path: `${directory}/page-pins.png`, fullPage: true });
  await page.getByRole("button", { name: "Close page map", exact: true }).click();
  await page.getByRole("button", { name: "Reset reading position", exact: true }).click();
  await expect(page.getByText("1 / 60", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Close viewer", exact: true }).click();
  await page.getByRole("button", { name: "Reopen viewer", exact: true }).click();
  await page.getByRole("button", { name: "Page map", exact: true }).click();
  await page.getByRole("button", { name: "Open pin: Page 42, Chart", exact: true }).click();
  await expect(page.getByText("42 / 60", { exact: true })).toBeVisible();
  // A rewrite keeps the pin but asks the user to check it; confirming takes the new revision.
  const rewritten = await PDFDocument.load(await readFile(`${directory}/report.pdf`));
  rewritten.removePage(0);
  await writeFile(`${root}/report.pdf`, await rewritten.save());
  await page.getByRole("button", { name: "Page map", exact: true }).click();
  const changedPin = page.getByRole("button", { name: /^Open pin: Page 42, Chart, May need checking/ });
  await expect(changedPin).toBeVisible({ timeout: 12000 });
  await page.getByRole("button", { name: "Confirm pin on page 42", exact: true }).click();
  await expect(page.getByRole("button", { name: "Open pin: Page 42, Chart", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Remove pin on page 42", exact: true }).click();
  await expect(page.getByRole("button", { name: /^Open pin:/ })).toHaveCount(0);
  await page.getByRole("button", { name: "Close page map", exact: true }).click();
  // Closing the map stops further thumbnail requests; only those already sent may finish.
  await page.unroute("**/rpc", slowThumbnails);
  const verySlow = async (route) => {
    if (route.request().postDataJSON().method === "doc.thumbnail") await new Promise((resolve) => setTimeout(resolve, 600));
    await route.continue().catch(() => {});
  };
  await page.route("**/rpc", verySlow);
  await page.getByRole("button", { name: "statement.pdf", exact: true }).click();
  await page.getByRole("button", { name: "Page map", exact: true }).click();
  await expect(page.getByRole("button", { name: "Open page 3", exact: true })).toBeVisible();
  const sentBeforeClose = thumbnails.requested.length;
  await page.getByRole("button", { name: "Close page map", exact: true }).click();
  await page.waitForTimeout(1500);
  expect(thumbnails.requested.length - sentBeforeClose).toBe(0);
  expect(thumbnails.inFlight).toBe(0);
  await page.unroute("**/rpc", verySlow);
  // Review marks follow explicit presses only, for the revision on screen.
  const reviews = [];
  const recordReview = (request) => { if (request.url().endsWith("/rpc") && request.postDataJSON()?.method === "viewer-state.review") reviews.push(request.postDataJSON().input); };
  page.on("request", recordReview);
  const touch = async (name, seconds) => { await writeFile(`${root}/${name}`, await readFile(`${root}/${name}`)); await utimes(`${root}/${name}`, seconds, seconds); };
  await page.getByRole("button", { name: "statement.pdf", exact: true }).click();
  await page.getByRole("button", { name: "Next page", exact: true }).click();
  await page.waitForTimeout(1300);
  await expect(page.getByRole("button", { name: "Mark reviewed", exact: true })).toBeVisible();
  expect(reviews).toHaveLength(0);
  await page.getByRole("button", { name: "Mark reviewed", exact: true }).click();
  await expect(page.getByRole("button", { name: "Reviewed, clear the review mark", exact: true })).toBeVisible();
  expect(reviews).toHaveLength(1);
  await page.getByRole("button", { name: "Documents", exact: true }).click();
  await expect(page.getByRole("button", { name: /^Open statement\.pdf, PDF, .*, reviewed$/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Open long\.pdf, PDF, [^,]*$/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Needs review/ })).toHaveCount(0);
  await touch("statement.pdf", Date.now() / 1000 + 60);
  await expect(page.getByRole("button", { name: /^Open statement\.pdf, PDF, .*, changed since review$/ })).toBeVisible({ timeout: 15000 });
  // Needs review leads the filter row, so it is not scrolled off on a phone.
  await expect(page.getByRole("button", { name: /^(Needs review|All), / }).first()).toHaveAttribute("aria-label", "Needs review, 1 document");
  await page.getByRole("button", { name: "Needs review, 1 document", exact: true }).click();
  await expect(page.getByRole("button", { name: /^Open / })).toHaveCount(1);
  await page.screenshot({ path: `${directory}/needs-review.png`, fullPage: true });
  await page.getByRole("button", { name: /^Open statement\.pdf/ }).click();
  await expect(page.getByText("Changed since review", { exact: true })).toBeVisible();
  await expect(page.getByText("Changed since review", { exact: true })).toBeVisible();
  // A rewrite the open viewer has not picked up yet must not be marked reviewed.
  await touch("statement.pdf", Date.now() / 1000 + 120);
  await page.getByRole("button", { name: "Mark reviewed", exact: true }).click();
  await page.waitForTimeout(500);
  await expect(page.getByRole("button", { name: "Reviewed, clear the review mark", exact: true })).toHaveCount(0);
  await expect(page.getByText("Changed since review", { exact: true })).toBeVisible();
  await page.waitForTimeout(5500);
  await page.getByRole("button", { name: "Mark reviewed", exact: true }).click();
  await expect(page.getByRole("button", { name: "Reviewed, clear the review mark", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Documents", exact: true }).click();
  await expect(page.getByRole("button", { name: /^Open statement\.pdf, PDF, .*, reviewed$/ })).toBeVisible();
  page.off("request", recordReview);
  // Review notes: collect notes on two pages, leave the document and come back, then edit,
  // preview, copy and send them, with a busy, a racing and a failing recipient keeping the draft.
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.getByRole("button", { name: "invoices.xlsx", exact: true }).click();
  await page.getByRole("button", { name: "statement.pdf", exact: true }).click();
  await page.getByRole("button", { name: "Page 1", exact: true }).click();
  await expect(page.getByText("1 / 3", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Add note to page 1", exact: true }).click();
  await page.getByRole("textbox", { name: "Note text", exact: true }).fill("Legend overlaps the axis");
  await page.getByRole("button", { name: "Add note", exact: true }).click();
  await expect(page.getByRole("button", { name: "Review notes (1)", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Next page", exact: true }).click();
  await page.getByRole("button", { name: "Add note to page 2", exact: true }).click();
  await page.getByRole("textbox", { name: "Note text", exact: true }).fill("Move this table onto its own page");
  await expect(page.getByRole("checkbox", { name: "Attach page image", exact: true })).toHaveAttribute("aria-checked", "false");
  await page.getByRole("checkbox", { name: "Attach page image", exact: true }).click();
  await expect(page.getByRole("checkbox", { name: "Attach page image", exact: true })).toHaveAttribute("aria-checked", "true");
  await page.screenshot({ path: `${directory}/review-compose.png`, fullPage: true });
  await page.getByRole("button", { name: "Add note", exact: true }).click();
  await expect(page.getByRole("button", { name: "Review notes (2)", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "contract.docx", exact: true }).click();
  await expect(page.getByRole("button", { name: "Review notes (2)", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Review notes (2)", exact: true }).click();
  await expect(page.getByText("2 notes", { exact: true })).toBeVisible();
  await expect(page.getByText("Page image attached", { exact: true })).toHaveCount(1);
  const preview = page.getByLabel("Review message", { exact: true });
  await expect(preview).toContainText("- Page 1: Legend overlaps the axis");
  await expect(preview).toContainText("- Page 2: Move this table onto its own page [image 1]");
  await expect(page.getByText(/^1 page image \(/)).toBeVisible();
  await page.getByRole("button", { name: "Edit note on page 1", exact: true }).click();
  await page.getByRole("textbox", { name: "Edit note text", exact: true }).fill("Legend overlaps the x axis");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(preview).toContainText("- Page 1: Legend overlaps the x axis");
  await page.getByRole("button", { name: "Copy review", exact: true }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain("- Page 1: Legend overlaps the x axis");
  const radios = page.getByRole("radio");
  await expect(radios).toHaveCount(4);
  expect(await radios.evaluateAll((nodes) => nodes.map((node) => node.getAttribute("aria-label")))).toEqual(
    ["Docs agent, Idle", "Racing agent, Idle", "Broken agent, Idle", "Busy agent, Busy"]);
  await expect(page.getByRole("radio", { name: "Busy agent, Busy", exact: true })).toHaveAttribute("aria-disabled", "true");
  await page.getByRole("radio", { name: "Racing agent, Idle", exact: true }).click();
  await page.getByRole("button", { name: "Send review to Racing agent", exact: true }).click();
  await expect(page.getByText("Racing agent is not ready (busy). Nothing was sent; the draft is kept.", { exact: true })).toBeVisible();
  await page.getByRole("radio", { name: "Broken agent, Idle", exact: true }).click();
  await page.getByRole("button", { name: "Send review to Broken agent", exact: true }).click();
  await expect(page.getByText(/^Could not send the review: sendAgentMessage rejected/)).toBeVisible();
  await expect(page.getByText("2 notes", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => window.__sentReviews.length)).toBe(0);
  await page.request.get(`http://127.0.0.1:${port}/touch/statement.pdf`);
  await expect(page.getByText("Older revision: the file changed since this note", { exact: true })).toHaveCount(2, { timeout: 12000 });
  await expect(preview).toContainText("older revision");
  await expect(page.getByRole("button", { name: "Attach page 1 image", exact: true })).toHaveAttribute("aria-disabled", "true");
  await page.screenshot({ path: `${directory}/review-screen.png`, fullPage: true });
  await page.getByRole("radio", { name: "Docs agent, Idle", exact: true }).click();
  await page.getByRole("button", { name: "Send review to Docs agent", exact: true }).click();
  await expect(page.getByText("Review sent to Docs agent", { exact: true })).toBeVisible();
  const delivered = await page.evaluate(() => window.__sentReviews);
  expect(delivered).toHaveLength(1);
  expect(delivered[0].id).toBe("docs");
  expect(delivered[0].options.activeTurnBehavior).toBe("steer");
  expect(delivered[0].options.images).toHaveLength(1);
  expect(delivered[0].text).toContain("statement.pdf, older revision");
  await page.screenshot({ path: `${directory}/review-sent.png`, fullPage: true });
  await page.getByRole("button", { name: "Open agent", exact: true }).click();
  expect(await page.evaluate(() => window.__openedAgent)).toBe("docs");
  await page.getByRole("button", { name: "statement.pdf", exact: true }).click();
  await expect(page.getByRole("button", { name: /^Add note to page / })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Review notes/ })).toHaveCount(0);
  // Phone layout: every PDF toolbar control, including the review ones, fits inside 390 px on one line.
  // The browser runs single-process, so the same page switches to the phone viewport.
  const phone = page;
  await phone.setViewportSize({ width: 390, height: 844 });
  await phone.goto(`http://127.0.0.1:${port}/?compact`);
  await phone.getByRole("button", { name: "report.pdf", exact: true }).click();
  // Download sits in the tools row: no row of its own above the toolbar.
  const findBox = await phone.getByRole("button", { name: "Find in document", exact: true }).boundingBox();
  const downloadBox = await phone.getByRole("button", { name: "Download original", exact: true }).boundingBox();
  expect(Math.abs(downloadBox.y - findBox.y)).toBeLessThan(2);
  // Phones show `< n / N >` without chips; n / N opens the page map, and Reset is left to Fit and the map.
  await expect(phone.getByRole("button", { name: /^Page \d+$/ })).toHaveCount(0);
  await expect(phone.getByRole("button", { name: "Reset reading position", exact: true })).toHaveCount(0);
  await phone.getByRole("button", { name: /^Page \d+ of \d+, open page map$/ }).click();
  await phone.getByLabel("Page thumbnails", { exact: true }).evaluate((element) => { element.parentElement.parentElement.scrollTop = 0; });
  await phone.getByRole("button", { name: "Open page 1", exact: true }).click();
  await expect(phone.getByText(/^1 \/ \d+$/)).toBeVisible();
  await phone.getByRole("button", { name: "Add note to page 1", exact: true }).click();
  await phone.getByRole("textbox", { name: "Note text", exact: true }).fill("Fits on a phone");
  await phone.getByRole("button", { name: "Add note", exact: true }).click();
  await expect(phone.getByRole("button", { name: "Review notes (1)", exact: true })).toBeVisible();
  for (const name of ["Find in document", "Page map", "Add note to page 1", "Review notes (1)", "Mark reviewed", "Download original", "Previous page", "Page 1 of 59, open page map", "Next page", "Show page text", "Zoom out", "Zoom in"]) {
    const box = await phone.getByRole("button", { name, exact: true }).boundingBox();
    expect(box, name).not.toBeNull();
    expect(box.x, name).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width, name).toBeLessThanOrEqual(390);
    // 40 pt controls plus a 4 pt hit slop make 44 pt touch targets on phones.
    expect(box.height, name).toBeGreaterThanOrEqual(40);
  }
  const counter = await phone.getByText(/^1 \/ \d+$/).boundingBox();
  expect(counter.height).toBeLessThan(20);
  expect(await phone.evaluate(() => document.querySelector("main").scrollWidth)).toBe(390);
  await phone.screenshot({ path: `${directory}/phone-toolbar.png` });
  // Under an error the download stands alone, so it keeps its label on phones too.
  await phone.goto(`http://127.0.0.1:${port}/?compact`);
  await phone.getByRole("button", { name: "broken.pdf", exact: true }).click();
  await expect(phone.getByRole("button", { name: "Download original", exact: true })).toContainText("Download original");
  expect(failures).toEqual([]);
  console.log("Browser checks passed: persisted page/zoom/sheet, reset, scoped find shortcut, PDF/Word/grid find navigation, cell inspector, record cards, bounded issue check, original-file download bytes, WAV decoding/playback, WebM audio-track playback, visible media/animation/download loading with cancel and navigation, stale-query/cancel/slow-position races, PDF page map (visible-first, at most two thumbnail requests, open page, close stops requests), page pins (label, revisit after reopen, may need checking after rewrite, confirm, remove), review marks (explicit only, Documents status and Needs review filter, rewrite race), review notes (collect, edit, preview, copy, stale, send), phone toolbar fit.");
  console.log(`Screenshots: ${directory}`);
} catch (error) { if (page) { console.error((await page.locator("body").innerText()).slice(0, 1800)); await page.screenshot({ path: `${directory}/failure.png`, fullPage: true }); } throw error; } finally { await browser?.close(); server.kill("SIGTERM"); await rm(stateDirectory, { recursive: true, force: true }); }
