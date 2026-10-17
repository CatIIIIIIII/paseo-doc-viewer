import { createHash, randomBytes } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { z } from "zod";
import { viewerPosition, type ViewerPosition } from "../shared/viewer-state";
import { resolveInside } from "./paths";

const record = z.object({ revision: z.string().max(256), position: viewerPosition, touched: z.number() });
const stored = z.object({ version: z.literal(1), entries: z.record(z.string(), record) });
const MAX_ENTRIES = 500;
const MAX_BYTES = 1024 * 1024;

// One store per daemon process; all writes pass through the same queue.
export class ViewerStateStore {
  private tail: Promise<unknown> = Promise.resolve();
  constructor(private directory: string) {}

  private async load(): Promise<z.infer<typeof stored>> {
    try {
      const path = join(this.directory, "positions.json");
      if ((await stat(path)).size > MAX_BYTES) return { version: 1, entries: {} };
      return stored.parse(JSON.parse(await readFile(path, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError || error instanceof z.ZodError) {
        return { version: 1, entries: {} };
      }
      throw error;
    }
  }

  private queue<T>(run: () => Promise<T>): Promise<T> {
    const next = this.tail.then(run, run);
    this.tail = next.catch(() => {});
    return next;
  }

  read(key: string) {
    return this.queue(async () => (await this.load()).entries[key] ?? null);
  }

  write(key: string, revision: string, position: ViewerPosition | null): Promise<void> {
    return this.queue(async () => {
      const data = await this.load();
      if (position === null) delete data.entries[key];
      else data.entries[key] = record.parse({ revision, position, touched: Date.now() });
      const entries = Object.entries(data.entries).sort((a, b) => b[1].touched - a[1].touched).slice(0, MAX_ENTRIES);
      data.entries = Object.fromEntries(entries);
      let serialized = JSON.stringify(data);
      while (Buffer.byteLength(serialized, "utf8") > MAX_BYTES && entries.length > 0) {
        const oldest = entries.pop()!;
        delete data.entries[oldest[0]];
        serialized = JSON.stringify(data);
      }
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const temporary = join(this.directory, `positions-${randomBytes(8).toString("hex")}.tmp`);
      try {
        const file = await open(temporary, "wx", 0o600);
        try { await file.writeFile(serialized); } finally { await file.close(); }
        await rename(temporary, join(this.directory, "positions.json"));
      } finally {
        await rm(temporary, { force: true });
      }
    });
  }
}

export async function positionKey(root: string, path: string): Promise<string> {
  const target = await resolveInside(root, path);
  return createHash("sha256").update(root).update("\0").update(relative(root, target)).digest("hex");
}

const configuredDirectory = process.env.PASEO_DOC_VIEWER_STATE_DIR;
export const viewerStateStore = new ViewerStateStore(
  configuredDirectory && isAbsolute(configuredDirectory) ? configuredDirectory : join(homedir(), ".local", "state", "paseo-doc-viewer"),
);
