import { build } from "esbuild";
import { chromium, expect } from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { once } from "node:events";
import { PDFDocument, StandardFonts } from "pdf-lib";
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
const base = { bundle: true, jsx: "automatic", logLevel: "silent" };
await build({ ...base, entryPoints: ["test/browser/app.tsx"], outfile: `${directory}/app.js`, platform: "browser", alias: {
  "react-native": resolve("test/browser/native-shim.tsx"),
  "@getpaseo/plugin/client/react-native": resolve("test/browser/native-shim.tsx"),
  "@getpaseo/plugin/client": resolve("test/browser/plugin-shim.ts"),
} });
await build({ ...base, entryPoints: ["test/browser/server.ts"], outfile: `${directory}/server.cjs`, platform: "node", format: "cjs", external: ["@getpaseo/plugin", "zod"] });
const server = spawn(process.execPath, [`${directory}/server.cjs`], { stdio: ["ignore", "pipe", "inherit"] });
let browser;
let page;
try {
  const output = await Promise.race([once(server.stdout, "data"), once(server, "exit").then(() => { throw new Error("Harness exited before listening"); })]);
  const { port } = JSON.parse(output[0].toString());
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_EXECUTABLE_PATH, args: ["--no-sandbox", "--disable-dev-shm-usage", "--no-zygote", "--single-process", "--disable-gpu", "--disable-software-rasterizer"] });
  page = await browser.newPage({ viewport: { width: 1100, height: 1000 }, acceptDownloads: true });
  const failures = [];
  page.on("pageerror", (error) => { failures.push(error.message); console.error("Browser error:", error.message); });
  await page.goto(`http://127.0.0.1:${port}`);
  await expect(page.getByRole("button", { name: "Next page", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Next page", exact: true }).click();
  await expect(page.getByText("2 / 3", { exact: true })).toBeVisible();
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
  await expect(page.getByRole("button", { name: "Show page image", exact: true })).toBeVisible();
  await expect(page.getByText("statement", { exact: true })).toBeVisible();
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
  await expect(page.getByText("B2", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "long.pdf", exact: true }).click();
  await page.getByRole("button", { name: "Find in document", exact: true }).click();
  await page.getByRole("textbox", { name: "Find in document", exact: true }).fill("needle");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await page.getByRole("button", { name: /^Page 1: / }).click();
  await expect(page.getByLabel("Current match: needle")).toBeInViewport();
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
  expect(failures).toEqual([]);
  console.log("Browser checks passed: persisted page/zoom/sheet, reset, scoped find shortcut, PDF/Word/grid find navigation, original-file download bytes, WAV decoding/playback, WebM audio-track playback, stale-query/cancel/slow-position races.");
  console.log(`Screenshots: ${directory}`);
} catch (error) { if (page) { console.error((await page.locator("body").innerText()).slice(0, 1800)); await page.screenshot({ path: `${directory}/failure.png`, fullPage: true }); } throw error; } finally { await browser?.close(); server.kill("SIGTERM"); }
