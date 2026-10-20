import fs, { copyFileSync, mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";
import { afterEach, vi } from "vitest";

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

// CPU time of the whole test process, worker threads included: the work done, which other load on the
// machine does not stretch the way it stretches wall time.
export async function cpuTimed<T>(run: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const started = process.cpuUsage();
  const value = await run();
  const { user, system } = process.cpuUsage(started);
  return { value, ms: (user + system) / 1000 };
}

// The most CPU this thread spent between two ticks of a 10 ms timer while `run` ran: the longest it held
// the event loop. A busy machine delays the timer itself, but does not inflate this.
export async function longestBlockMs(run: () => Promise<unknown>): Promise<number> {
  const cpuMs = () => {
    const { user, system } = process.threadCpuUsage();
    return (user + system) / 1000;
  };
  let longest = 0;
  let last = cpuMs();
  const probe = setInterval(() => {
    const now = cpuMs();
    longest = Math.max(longest, now - last);
    last = now;
  }, 10);
  try {
    await run();
    // One more tick, so a block just before `run` settled counts too.
    await new Promise((resolve) => setTimeout(resolve, 20));
  } finally {
    clearInterval(probe);
  }
  return longest;
}

// Bytes read from `file` while `run` runs, through each way the server reads files: fs/promises readFile,
// handles from fs/promises open, and createReadStream. Spying on the CommonJS objects, then syncing the
// builtins' ESM exports, reaches the server's named imports too.
export async function bytesRead<T>(file: string, run: () => Promise<T>): Promise<{ value: T; bytes: number }> {
  const target = realpathSync(file);
  const handles = new WeakSet<object>();
  const isTarget = (path: unknown) => {
    if (typeof path === "object" && path !== null) return handles.has(path);
    try { return typeof path === "string" && realpathSync(path) === target; } catch { return false; }
  };
  let bytes = 0;
  const count = (data: unknown) => {
    if (typeof data === "string") bytes += Buffer.byteLength(data);
    else if (data instanceof Uint8Array) bytes += data.byteLength;
    else if (typeof data === "object" && data !== null && "bytesRead" in data) bytes += Number(data.bytesRead);
  };
  // Calls `seen` with each result of owner[key], once it has resolved.
  const watch = (owner: object, key: string, seen: (result: unknown, self: unknown, args: unknown[]) => void) => {
    const methods = owner as Record<string, (...args: unknown[]) => unknown>;
    const original = methods[key];
    return vi.spyOn(methods, key).mockImplementation(function (this: unknown, ...args: unknown[]) {
      const result = original.apply(this, args);
      if (result instanceof Promise) return result.then((value) => { seen(value, this, args); return value; });
      seen(result, this, args);
      return result;
    });
  };
  const probe = await fs.promises.open(target, "r");
  const handleMethods: object = Object.getPrototypeOf(probe);
  await probe.close();
  const spies = [
    watch(fs.promises, "readFile", (data, _, [path]) => { if (isTarget(path)) count(data); }),
    watch(fs.promises, "open", (handle, _, [path]) => { if (isTarget(path)) handles.add(handle as object); }),
    ...["read", "readv", "readFile"].map((key) => watch(handleMethods, key, (result, handle) => { if (handles.has(handle as object)) count(result); })),
    watch(fs, "createReadStream", (stream, _, [path]) => { if (isTarget(path)) watch(stream as object, "push", (_, __, [chunk]) => count(chunk)); }),
  ];
  syncBuiltinESMExports();
  try {
    return { value: await run(), bytes };
  } finally {
    for (const spy of spies) spy.mockRestore();
    syncBuiltinESMExports();
  }
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
