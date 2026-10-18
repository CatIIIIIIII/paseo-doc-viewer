import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

const stored = z.object({ version: z.literal(1), dismissedAt: z.number().nonnegative() });

// Whether the first-run tips in Documents were dismissed: one flag in the viewer state folder, so
// every client of the daemon sees the same answer. A missing or unreadable file means not dismissed.
export class TipsStore {
  constructor(private directory: string) {}

  async read(): Promise<{ dismissed: boolean }> {
    try {
      return { dismissed: stored.safeParse(JSON.parse(await readFile(join(this.directory, "tips.json"), "utf8"))).success };
    } catch {
      return { dismissed: false };
    }
  }

  async dismiss(now = Date.now()): Promise<{ dismissed: true }> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const temporary = join(this.directory, `tips-${randomBytes(8).toString("hex")}.tmp`);
    try {
      await writeFile(temporary, JSON.stringify({ version: 1, dismissedAt: now }), { mode: 0o600 });
      await rename(temporary, join(this.directory, "tips.json"));
    } finally {
      await rm(temporary, { force: true });
    }
    return { dismissed: true };
  }
}
