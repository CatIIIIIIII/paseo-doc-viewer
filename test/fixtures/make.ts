import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { alphaRampPng, deckPptx, hugePagePdf, solidPng, tiffFromPng, wideWorkbook } from "./generators.ts";

const dir = dirname(fileURLToPath(import.meta.url));
const at = (name: string) => join(dir, name);
const photo = readFileSync(at("photo.png"));

writeFileSync(at("huge-page.pdf"), await hugePagePdf());
writeFileSync(at("wide.xlsx"), await wideWorkbook(300, 400, 100_000));
writeFileSync(
  at("deck.pptx"),
  await deckPptx(
    Array.from({ length: 11 }, (_, i) => ({
      title: `Slide ${i + 1}`,
      body: `Body text of slide ${i + 1}`,
      images: i === 1 ? [photo] : [],
    })),
  ),
);
writeFileSync(at("photo.tiff"), tiffFromPng(photo));

function tool(name: string): boolean {
  try {
    execFileSync("which", [name], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

if (tool("sips")) {
  execFileSync("sips", ["-s", "format", "heic", at("photo.png"), "--out", at("photo.heic")], { stdio: "ignore" });
} else if (!existsSync(at("photo.heic"))) {
  console.warn("sips not found: photo.heic not generated");
}

if (tool("ffmpeg")) {
  execFileSync(
    "ffmpeg",
    ["-y", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=size=160x120:rate=10:duration=1",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", at("clip.mp4")],
  );
} else if (!existsSync(at("clip.mp4"))) {
  console.warn("ffmpeg not found: clip.mp4 not generated");
}

if (tool("cwebp") && tool("img2webp")) {
  const scratch = mkdtempSync(join(tmpdir(), "webp-fixtures-"));
  const source = (name: string, png: Buffer) => {
    writeFileSync(join(scratch, name), png);
    return join(scratch, name);
  };
  const quiet = { stdio: "ignore" } as const;
  execFileSync("cwebp", ["-quiet", "-q", "85", at("photo.png"), "-o", at("photo-lossy.webp")], quiet);
  execFileSync("cwebp", ["-quiet", "-lossless", "-exact", source("alpha.png", alphaRampPng(photo)), "-o", at("alpha-lossless.webp")], quiet);
  execFileSync(
    "img2webp",
    ["-loop", "0", "-lossy", "-d", "100", source("red.png", solidPng(64, 48, [220, 30, 30])),
      "-lossless", "-d", "100", source("blue.png", solidPng(64, 48, [30, 30, 220])), "-o", at("animated.webp")],
    quiet,
  );
} else if (!existsSync(at("photo-lossy.webp"))) {
  console.warn("cwebp/img2webp not found: WebP fixtures not generated");
}
