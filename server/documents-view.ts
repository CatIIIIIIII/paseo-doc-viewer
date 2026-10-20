import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type DocumentView, type DocumentViews, documentView } from "../shared/documents-view";
import type { LayoutClass } from "../shared/viewer-state";
import { withFileLock } from "./file-lock";

const FILE = "documents-view.json";
const LAYOUTS: readonly LayoutClass[] = ["compact", "wide"];

type Saved = { [key: string]: unknown; version: number; views: Record<string, unknown> };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

// The whole file, or null when there is none. A file that is not a views file throws a SyntaxError.
async function load(path: string): Promise<Saved | null> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const data: unknown = JSON.parse(text);
  if (!isRecord(data) || (data.views !== undefined && !isRecord(data.views))) throw new SyntaxError(`${FILE} is not a views file`);
  return { ...data, version: typeof data.version === "number" && data.version > 1 ? data.version : 1, views: data.views ?? {} };
}

// Each layout is read on its own, so a view this version does not know leaves the other one intact.
function understood(saved: Saved | null): DocumentViews {
  const views: DocumentViews = {};
  for (const layout of LAYOUTS) {
    const parsed = documentView.safeParse(saved?.views[layout]);
    if (parsed.success) views[layout] = parsed.data;
  }
  return views;
}

export class DocumentViewStore {
  private tail: Promise<unknown> = Promise.resolve();
  constructor(private directory: string) {}

  async read(): Promise<{ views: DocumentViews }> {
    try {
      return { views: understood(await load(join(this.directory, FILE))) };
    } catch {
      return { views: {} };
    }
  }

  // A write holds documents-view.lock and changes one layout in the file as it is then, so stores sharing
  // the folder keep each other's choice. A later version's number, views and fields are kept; a damaged
  // file is kept aside as documents-view.json.bad.
  write(layout: LayoutClass, view: DocumentView): Promise<{ views: DocumentViews }> {
    const run = this.tail.then(async () => {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      return withFileLock(join(this.directory, "documents-view.lock"), async () => {
        const path = join(this.directory, FILE);
        let saved: Saved | null = null;
        try {
          saved = await load(path);
        } catch (error) {
          if (!(error instanceof SyntaxError)) throw error;
          console.error(`[doc-viewer] ${FILE} could not be read; keeping it as ${FILE}.bad:`, error.message);
          await rename(path, `${path}.bad`).catch(() => {});
        }
        const next: Saved = { ...saved, version: saved?.version ?? 1, views: { ...saved?.views, [layout]: view } };
        const temporary = join(this.directory, `documents-view-${randomBytes(8).toString("hex")}.tmp`);
        try {
          await writeFile(temporary, JSON.stringify(next), { mode: 0o600 });
          await rename(temporary, path);
        } finally {
          await rm(temporary, { force: true });
        }
        return { views: understood(next) };
      });
    });
    this.tail = run.catch(() => {});
    return run;
  }
}
