import { copyFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";
import { afterEach } from "vitest";

export const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
export const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const created: string[] = [];
// Removing a 50,000-file workspace (r3) can pass the 10 s default hook timeout on a loaded machine.
afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
}, 60_000);

export function workspace(files: Record<string, string | Uint8Array> = {}): string {
  const root = mkdtempSync(join(tmpdir(), "doc-viewer-"));
  created.push(root);
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, name)), { recursive: true });
    writeFileSync(join(root, name), content);
  }
  return root;
}

export function workspaceWithFixtures(...names: string[]): string {
  const root = workspace();
  for (const name of names) copyFileSync(join(FIXTURES, name), join(root, name));
  return root;
}

export function responseBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

export async function timed<T>(run: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const started = performance.now();
  const value = await run();
  return { value, ms: performance.now() - started };
}

export function decodePng(base64: string): PNG {
  return PNG.sync.read(Buffer.from(base64, "base64"));
}

export function inkRatio(png: PNG): number {
  let ink = 0;
  for (let i = 0; i < png.data.length; i += 4) {
    if (png.data[i] < 200 || png.data[i + 1] < 200 || png.data[i + 2] < 200) ink++;
  }
  return ink / (png.width * png.height);
}
