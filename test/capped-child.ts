import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import { PLUGIN_ROOT } from "./helpers";

export interface CappedResult {
  code: number | null;
  signal: string | null;
  stdout: string;
}

// Bundles `source` (TypeScript that may import plugin modules by absolute path) and runs it in a
// child with a small heap, so a regression that exhausts memory fails the test instead of the worker.
export async function runCapped(source: string, args: string[] = [], heapMb = 128, timeoutMs = 30_000): Promise<CappedResult> {
  const dir = mkdtempSync(join(tmpdir(), "doc-viewer-capped-"));
  try {
    const probe = join(dir, "probe.mjs");
    await build({
      stdin: { contents: source, resolveDir: PLUGIN_ROOT, loader: "ts" },
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node20",
      outfile: probe,
      banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
      logLevel: "silent",
    });
    return await new Promise((resolve) => {
      execFile(process.execPath, [`--max-old-space-size=${heapMb}`, probe, ...args], { timeout: timeoutMs, maxBuffer: 1 << 20 }, (error, stdout) => {
        const failure = error as (Error & { code?: number | string; signal?: string | null }) | null;
        resolve({ code: failure ? (typeof failure.code === "number" ? failure.code : null) : 0, signal: failure?.signal ?? null, stdout });
      });
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export const pluginModule = (path: string) => JSON.stringify(join(PLUGIN_ROOT, path));
