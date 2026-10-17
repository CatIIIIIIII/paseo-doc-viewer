import { createHmac, randomBytes } from "node:crypto";
import { mkdir, open, readdir, readFile, rename, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";
import { z } from "zod";
import { viewerPosition, type ViewerPosition } from "../shared/viewer-state";
import { resolveInside } from "./paths";

const record = z.object({ position: viewerPosition, touched: z.number() });
const stored = z.object({ version: z.literal(1), entries: z.record(z.string(), record) });
const MAX_ENTRIES = 500;
const MAX_BYTES = 1024 * 1024;
const SECRET_BYTES = 32;
const STALE_TEMPORARY_MS = 60_000;

export function stateDirectory(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  const configured = env.PASEO_DOC_VIEWER_STATE_DIR;
  if (configured && isAbsolute(configured)) return configured;
  const xdg = env.XDG_STATE_HOME;
  return join(xdg && isAbsolute(xdg) ? xdg : join(home, ".local", "state"), "paseo-doc-viewer");
}

// One store per daemon process; all reads and writes pass through the same queue.
export class ViewerStateStore {
  private tail: Promise<unknown> = Promise.resolve();
  private secret: Promise<Buffer> | null = null;
  private prepared: Promise<void> | null = null;
  constructor(private directory: string) {}

  // Keys are salted with a per-install secret, so the file does not reveal which paths were opened.
  async key(root: string, path: string): Promise<string> {
    const target = await resolveInside(root, path);
    this.secret ??= this.loadSecret();
    this.secret.catch(() => (this.secret = null));
    return createHmac("sha256", await this.secret).update(root).update("\0").update(relative(root, target)).digest("hex");
  }

  read(key: string) {
    return this.queue(async () => (await this.load()).entries[key] ?? null);
  }

  write(key: string, position: ViewerPosition | null): Promise<void> {
    return this.queue(async () => {
      const data = await this.load();
      if (position === null) delete data.entries[key];
      else data.entries[key] = record.parse({ position, touched: Date.now() });
      const entries = Object.entries(data.entries).sort((a, b) => b[1].touched - a[1].touched).slice(0, MAX_ENTRIES);
      data.entries = Object.fromEntries(entries);
      let serialized = JSON.stringify(data);
      while (Buffer.byteLength(serialized, "utf8") > MAX_BYTES && entries.length > 0) {
        const oldest = entries.pop()!;
        delete data.entries[oldest[0]];
        serialized = JSON.stringify(data);
      }
      await this.ensureDirectory();
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

  private queue<T>(run: () => Promise<T>): Promise<T> {
    this.prepared ??= this.removeStaleTemporaries();
    const prepared = this.prepared;
    const next = this.tail.then(() => prepared).then(run, run);
    this.tail = next.catch(() => {});
    return next;
  }

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

  // Only the state directory itself is private; missing parents get ordinary permissions.
  private async ensureDirectory(): Promise<void> {
    await mkdir(dirname(this.directory), { recursive: true });
    await mkdir(this.directory, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    });
  }

  private async loadSecret(): Promise<Buffer> {
    const path = join(this.directory, "secret");
    try {
      const secret = await readFile(path);
      if (secret.length === SECRET_BYTES) return secret;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await this.ensureDirectory();
    const secret = randomBytes(SECRET_BYTES);
    const temporary = join(this.directory, `secret-${randomBytes(8).toString("hex")}.tmp`);
    try {
      const file = await open(temporary, "wx", 0o600);
      try { await file.writeFile(secret); } finally { await file.close(); }
      await rename(temporary, path);
    } finally {
      await rm(temporary, { force: true });
    }
    return secret;
  }

  // A crash between writing and renaming leaves a temporary file behind.
  private async removeStaleTemporaries(): Promise<void> {
    let names: string[];
    try {
      names = await readdir(this.directory);
    } catch {
      return;
    }
    const cutoff = Date.now() - STALE_TEMPORARY_MS;
    for (const name of names) {
      if (!/^(?:positions|secret)-[0-9a-f]{16}\.tmp$/.test(name)) continue;
      const path = join(this.directory, name);
      try {
        if ((await stat(path)).mtimeMs < cutoff) await rm(path, { force: true });
      } catch {}
    }
  }
}

export const viewerStateStore = new ViewerStateStore(stateDirectory());
