import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

const stored = z.object({ version: z.literal(1), visits: z.record(z.string(), z.number().nonnegative()) });
const MAX_WORKSPACES = 200;

// When Documents was last opened per workspace, kept apart from the viewer state so it never
// competes with positions, pins or review marks. Keys come from the caller (salted workspace roots).
export class VisitStore {
  private tail: Promise<unknown> = Promise.resolve();
  constructor(private directory: string, private keyOf: (root: string) => Promise<string>) {}

  // Records a visit at `now` and returns the previous one, or null the first time.
  visit(root: string, now = Date.now()): Promise<number | null> {
    const run = this.tail.then(async () => {
      const key = await this.keyOf(root);
      const visits = await this.load();
      const previous = visits[key] ?? null;
      visits[key] = now;
      const kept = Object.entries(visits).sort((a, b) => b[1] - a[1]).slice(0, MAX_WORKSPACES);
      await this.save(Object.fromEntries(kept));
      return previous;
    });
    this.tail = run.catch(() => {});
    return run;
  }

  private async load(): Promise<Record<string, number>> {
    try {
      const parsed = stored.safeParse(JSON.parse(await readFile(join(this.directory, "visits.json"), "utf8")));
      return parsed.success ? { ...parsed.data.visits } : {};
    } catch {
      return {};
    }
  }

  private async save(visits: Record<string, number>): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const temporary = join(this.directory, `visits-${randomBytes(8).toString("hex")}.tmp`);
    try {
      await writeFile(temporary, JSON.stringify({ version: 1, visits }), { mode: 0o600 });
      await rename(temporary, join(this.directory, "visits.json"));
    } finally {
      await rm(temporary, { force: true });
    }
  }
}
