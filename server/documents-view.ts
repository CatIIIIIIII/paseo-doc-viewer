import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { type DocumentView, type DocumentViews, documentViews } from "../shared/documents-view";
import type { LayoutClass } from "../shared/viewer-state";

const stored = z.object({ version: z.literal(1), views: documentViews });

export class DocumentViewStore {
  private tail: Promise<unknown> = Promise.resolve();
  constructor(private directory: string) {}

  async read(): Promise<{ views: DocumentViews }> {
    try {
      const parsed = stored.safeParse(JSON.parse(await readFile(join(this.directory, "documents-view.json"), "utf8")));
      return { views: parsed.success ? parsed.data.views : {} };
    } catch {
      return { views: {} };
    }
  }

  write(layout: LayoutClass, view: DocumentView): Promise<{ views: DocumentViews }> {
    const run = this.tail.then(async () => {
      const views = { ...(await this.read()).views, [layout]: view };
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const temporary = join(this.directory, `documents-view-${randomBytes(8).toString("hex")}.tmp`);
      try {
        await writeFile(temporary, JSON.stringify({ version: 1, views }), { mode: 0o600 });
        await rename(temporary, join(this.directory, "documents-view.json"));
      } finally {
        await rm(temporary, { force: true });
      }
      return { views };
    });
    this.tail = run.catch(() => {});
    return run;
  }
}
