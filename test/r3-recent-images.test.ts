import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { listRecent, openDocument, renderPage } from "../server/documents";
import { gif } from "./fixtures/generators.ts";
import { decodePng, responseBytes, workspace } from "./helpers";

const RED_LEFT_BLUE_RIGHT_16X8_JPEG = Buffer.from(
  "/9j/4AAQSkZJRgABAQAASABIAAD/4QBMRXhpZgAATU0AKgAAAAgAAYdpAAQAAAABAAAAGgAAAAAAA6ABAAMAAAABAAEAAKACAAQAAAABAAAAEKADAAQAAAABAAAACAAAAAD/7QA4UGhvdG9zaG9wIDMuMAA4QklNBAQAAAAAAAA4QklNBCUAAAAAABDUHYzZjwCyBOmACZjs+EJ+/8AAEQgACAAQAwEiAAIRAQMRAf/EAB8AAAEFAQEBAQEBAAAAAAAAAAABAgMEBQYHCAkKC//EALUQAAIBAwMCBAMFBQQEAAABfQECAwAEEQUSITFBBhNRYQcicRQygZGhCCNCscEVUtHwJDNicoIJChYXGBkaJSYnKCkqNDU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6g4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2drh4uPk5ebn6Onq8fLz9PX29/j5+v/EAB8BAAMBAQEBAQEBAQEAAAAAAAABAgMEBQYHCAkKC//EALURAAIBAgQEAwQHBQQEAAECdwABAgMRBAUhMQYSQVEHYXETIjKBCBRCkaGxwQkjM1LwFWJy0QoWJDThJfEXGBkaJicoKSo1Njc4OTpDREVGR0hJSlNUVVZXWFlaY2RlZmdoaWpzdHV2d3h5eoKDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uLj5OXm5+jp6vLz9PX29/j5+v/bAEMAAQEBAQEBAgEBAgMCAgIDBAMDAwMEBQQEBAQEBQYFBQUFBQUGBgYGBgYGBgcHBwcHBwgICAgICQkJCQkJCQkJCf/bAEMBAQEBAgICBAICBAkGBQYJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCf/dAAQAAf/aAAwDAQACEQMRAD8A/F+vyHr9eK/Iev8AVD/Rl/8Amtv+6f8A+7x/tR/pDP8AzSH/AHPf+6Z//9k=",
  "base64",
);

function withOrientation(jpeg: Buffer, orientation: number): Buffer {
  const tiff = Buffer.from([0x4d, 0x4d, 0, 0x2a, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, orientation, 0, 0, 0, 0, 0, 0]);
  const payload = Buffer.concat([Buffer.from("Exif\0\0", "latin1"), tiff]);
  const length = Buffer.alloc(2);
  length.writeUInt16BE(payload.length + 2);
  return Buffer.concat([jpeg.subarray(0, 2), Buffer.from([0xff, 0xe1]), length, payload, jpeg.subarray(2)]);
}

describe("R3: docs.recent finds the newest file in big trees", () => {
  it("continues past an oversized directory to the newest document", async () => {
    const root = workspace();
    mkdirSync(join(root, "a-many"));
    for (let i = 0; i < 50_100; i++) writeFileSync(join(root, "a-many", `f${i}.txt`), "");
    writeFileSync(join(root, "a-many", "old.pdf"), "%PDF-1.4");
    utimesSync(join(root, "a-many", "old.pdf"), 1000, 1000);
    mkdirSync(join(root, "z-reports"));
    writeFileSync(join(root, "z-reports", "newest.pdf"), "%PDF-1.4");
    const result = await listRecent(root, {});
    expect(result.entries.map((entry) => entry.path)).toContain("z-reports/newest.pdf");
    expect(result).toMatchObject({ truncated: true, truncatedBy: ["folder"] });
  }, 30_000);

  it("skips dependency folders and Office lock files but lists build output", async () => {
    const root = workspace({
      "report.pdf": "%PDF-1.4",
      "~$report.docx": "lock",
      "._report.pdf": "resource fork",
      "target/out.pdf": "%PDF-1.4",
      "build/out.pdf": "%PDF-1.4",
      "dist/out.pdf": "%PDF-1.4",
      "out/report.pdf": "%PDF-1.4",
      "vendor/out.pdf": "%PDF-1.4",
      ".next/out.pdf": "%PDF-1.4",
    });
    const result = await listRecent(root, {});
    expect(result.entries.map((entry) => entry.path).sort()).toEqual(["build/out.pdf", "dist/out.pdf", "out/report.pdf", "report.pdf"]);
    expect(result.truncated).toBe(false);
  });

  it("scans build output after other folders so it cannot use up the budget", async () => {
    const root = workspace();
    for (let d = 0; d < 10; d++) {
      mkdirSync(join(root, "build", `d${d}`), { recursive: true });
      for (let i = 0; i < 5_000; i++) writeFileSync(join(root, "build", `d${d}`, `f${i}.txt`), "");
    }
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "report.pdf"), "%PDF-1.4");
    utimesSync(join(root, "src"), 1000, 1000);
    const future = Date.now() / 1000 + 3600;
    utimesSync(join(root, "build"), future, future);
    const result = await listRecent(root, {});
    expect(result.entries.map((entry) => entry.path)).toEqual(["src/report.pdf"]);
    expect(result).toMatchObject({ truncated: true, truncatedBy: ["entries"] });
  }, 60_000);

  it("says a scan that skipped folders nested too deep was cut by depth, not by its entry budget", async () => {
    const chain = Array.from({ length: 17 }, (_, index) => `d${index + 1}`).join("/");
    const root = workspace({ "report.pdf": "%PDF-1.4", [`${chain}/deep.pdf`]: "%PDF-1.4" });
    const result = await listRecent(root, {});
    expect(result.entries.map((entry) => entry.path)).toEqual(["report.pdf"]);
    expect(result).toMatchObject({ truncated: true, truncatedBy: ["depth"] });
    const shallow = workspace({ "report.pdf": "%PDF-1.4", [`${chain.split("/").slice(0, 16).join("/")}/deep.pdf`]: "%PDF-1.4" });
    expect(await listRecent(shallow, {})).toMatchObject({ truncated: false });
  });

  it("gives every reason when the limit and the scan both cut the list", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 5_001; i++) files[`big/f${i}.txt`] = "";
    for (let i = 0; i < 3; i++) files[`out/run-${i}.pdf`] = "%PDF-1.4";
    files[`${Array.from({ length: 17 }, (_, index) => `d${index}`).join("/")}/deep.pdf`] = "%PDF-1.4";
    const result = await listRecent(workspace(files), { limit: 2 });
    expect(result.entries).toHaveLength(2);
    expect(result).toMatchObject({ truncated: true, truncatedBy: ["limit", "folder", "depth"] });
  }, 30_000);

  it("stops the list at its reply budget, however long and odd the names, and says so", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 12; i++) files[`${"\u0001\u001f".repeat(100)}-${i}.pdf`] = "%PDF-1.4";
    const root = workspace(files);
    const full = await listRecent(root, { limit: 1000 });
    expect(full).toMatchObject({ truncated: false });
    const budget = responseBytes(full.entries.slice(0, 6));
    const cut = await listRecent(root, { limit: 1000 }, undefined, budget);
    expect(cut.entries).toEqual(full.entries.slice(0, 6));
    expect(cut).toMatchObject({ truncated: true, truncatedBy: ["bytes"] });
    expect((await listRecent(root, { limit: 1000 }, undefined, budget - 1)).entries).toHaveLength(5);
    expect(await listRecent(root, { limit: 4 }, undefined, budget)).toMatchObject({ truncatedBy: ["limit"] });
    expect(await listRecent(root, { limit: 10 }, undefined, budget)).toMatchObject({ truncatedBy: ["limit", "bytes"] });
  });
});

describe("R3: GIF renders", () => {
  it("renders the first GIF frame as PNG", async () => {
    const palette = [[255, 0, 0], [0, 0, 255]];
    const indices = Array.from({ length: 30 * 20 }, (_, i) => (i % 30 < 15 ? 0 : 1));
    for (const interlaced of [false, true]) {
      const root = workspace({ "a.gif": gif(30, 20, palette, [indices], { interlaced }) });
      expect(await openDocument({ root, path: "a.gif" })).toMatchObject({ width: 30, height: 20 });
      const page = await renderPage({ root, path: "a.gif" }, { index: 0 });
      if (page.kind !== "image-raster") throw new Error("expected image");
      const png = decodePng(page.image.data);
      expect([...png.data.subarray(0, 3)]).toEqual([255, 0, 0]);
      const right = (5 * 30 + 29) * 4;
      expect([...png.data.subarray(right, right + 3)]).toEqual([0, 0, 255]);
    }
  });
});

describe("R3: JPEG EXIF orientation", () => {
  it("applies orientation 6 and swaps width and height", async () => {
    const root = workspace({ "portrait.jpg": withOrientation(RED_LEFT_BLUE_RIGHT_16X8_JPEG, 6) });
    expect(await openDocument({ root, path: "portrait.jpg" })).toMatchObject({ width: 8, height: 16 });
    const page = await renderPage({ root, path: "portrait.jpg" }, { index: 0 });
    if (page.kind !== "image-raster") throw new Error("expected image");
    expect(page).toMatchObject({ sourceWidth: 8, sourceHeight: 16 });
    expect(page.image).toMatchObject({ mimeType: "image/png", width: 8, height: 16 });
    const png = decodePng(page.image.data);
    const top = (1 * 8 + 4) * 4;
    const bottom = (14 * 8 + 4) * 4;
    expect(png.data[top]).toBeGreaterThan(200);
    expect(png.data[top + 2]).toBeLessThan(60);
    expect(png.data[bottom + 2]).toBeGreaterThan(200);
    expect(png.data[bottom]).toBeLessThan(60);
  });

  it("passes an upright JPEG through untouched", async () => {
    const root = workspace({ "upright.jpg": RED_LEFT_BLUE_RIGHT_16X8_JPEG });
    const page = await renderPage({ root, path: "upright.jpg" }, { index: 0 });
    if (page.kind !== "image-raster") throw new Error("expected image");
    expect(page.image).toMatchObject({ mimeType: "image/jpeg", width: 16, height: 8 });
  });
});
