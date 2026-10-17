import { createHmac, randomBytes } from "node:crypto";
import { mkdir, open, readdir, readFile, realpath, rename, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { z } from "zod";
import { ERROR_MESSAGES } from "../shared/errors";
import { PINS_MAX_PER_FILE } from "../shared/limits";
import { pagePins, reviewMark, viewerPosition, type PagePin, type ViewerPosition } from "../shared/viewer-state";
import { resolveInside } from "./paths";
import { revisionOf } from "./revision";

const record = z.object({ position: viewerPosition.optional(), pins: pagePins.optional(), review: reviewMark.optional(), touched: z.number() });
type Entry = Omit<z.infer<typeof record>, "touched">;
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
    const [target, realRoot] = await Promise.all([resolveInside(root, path), realpath(root)]);
    return (await this.scannedKeys(root))(relative(realRoot, target).split(sep).join("/"));
  }

  // For paths the workspace scan found: already canonical, inside the root and not symbolic links.
  async scannedKeys(root: string): Promise<(path: string) => string> {
    this.secret ??= this.loadSecret();
    this.secret.catch(() => (this.secret = null));
    const secret = await this.secret;
    return (path) => createHmac("sha256", secret).update(root).update("\0").update(path.split("/").join(sep)).digest("hex");
  }

  read(key: string) {
    return this.queue(async () => (await this.load()).entries[key] ?? null);
  }

  reviewedRevisions(): Promise<Map<string, string>> {
    return this.queue(async () => {
      const reviewed = new Map<string, string>();
      for (const [key, entry] of Object.entries((await this.load()).entries)) if (entry.review) reviewed.set(key, entry.review.revision);
      return reviewed;
    });
  }

  write(key: string, position: ViewerPosition | null): Promise<void> {
    return this.update(key, (current) => ({ ...current, position: position ?? undefined })).then(() => {});
  }

  // Applies one change to a document's record inside the queue; a record left empty is removed.
  update(key: string, change: (current: Entry | null) => Entry): Promise<Entry | null> {
    return this.queue(async () => {
      const data = await this.load();
      const existing = data.entries[key];
      const { touched: _touched, ...current } = existing ?? { touched: 0 };
      const next = record.parse({ ...change(existing ? current : null), touched: Date.now() });
      const empty = next.position === undefined && !next.pins?.length && next.review === undefined;
      if (empty) delete data.entries[key];
      else data.entries[key] = next;
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
      if (empty) return null;
      const { touched: _saved, ...saved } = next;
      return saved;
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

export async function readViewerState(store: ViewerStateStore, root: string, path: string) {
  const saved = await store.read(await store.key(root, path));
  return { saved: saved?.position ? { position: saved.position } : null, pins: saved?.pins ?? [], review: saved?.review ?? null };
}

// Marks only the revision the user was shown; if the file has moved on, the earlier mark stays.
export async function markReviewed(store: ViewerStateStore, root: string, path: string, revision: string | null) {
  const target = await resolveInside(root, path);
  const current = revisionOf(await stat(target));
  const key = await store.key(root, path);
  if (revision !== null && revision !== current) return { review: (await store.read(key))?.review ?? null, revision: current };
  const saved = await store.update(key, (existing) => ({ ...existing, review: revision === null ? undefined : { revision, at: Date.now() } }));
  return { review: saved?.review ?? null, revision: current };
}

// Pinning a page that already has a pin replaces its label and revision: that is how a pin is confirmed.
export async function setPin(store: ViewerStateStore, root: string, path: string, index: number, pin: { label?: string; revision: string } | null) {
  const saved = await store.update(await store.key(root, path), (current) => {
    const others = (current?.pins ?? []).filter((existing) => existing.index !== index);
    if (pin === null) return { ...current, pins: others };
    if (others.length >= PINS_MAX_PER_FILE) throw new Error(ERROR_MESSAGES.tooManyPins(PINS_MAX_PER_FILE));
    const label = pin.label?.trim();
    const added: PagePin = { index, ...(label ? { label } : {}), revision: pin.revision };
    return { ...current, pins: [...others, added].sort((a, b) => a.index - b.index) };
  });
  return { pins: saved?.pins ?? [] };
}
