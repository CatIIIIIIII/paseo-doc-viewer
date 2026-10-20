import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { DocumentViewStore } from "../server/documents-view";
import { documentsViewReadRpc, documentsViewWriteRpc } from "../shared/rpc";
import { workspace } from "./helpers";

const saved = (directory: string) => JSON.parse(readFileSync(join(directory, "documents-view.json"), "utf8"));

describe("Documents view store", () => {
  it("keeps one view per layout class for every store on the folder", async () => {
    const directory = join(workspace(), "state");
    const store = new DocumentViewStore(directory);
    expect(await store.read()).toEqual({ views: {} });
    expect(documentsViewWriteRpc.output.parse(await store.write("wide", "previews"))).toEqual({ views: { wide: "previews" } });
    await Promise.all([store.write("compact", "details"), store.write("wide", "details")]);
    expect(documentsViewReadRpc.output.parse(await new DocumentViewStore(directory).read())).toEqual({ views: { compact: "details", wide: "details" } });
    expect(saved(directory)).toEqual({ version: 1, views: { compact: "details", wide: "details" } });
    expect(statSync(join(directory, "documents-view.json")).mode & 0o777).toBe(0o600);
  });

  it("keeps Tree like the other views, beside a choice saved before Tree existed", async () => {
    const directory = workspace();
    writeFileSync(join(directory, "documents-view.json"), JSON.stringify({ version: 1, views: { compact: "details" } }));
    const store = new DocumentViewStore(directory);
    expect(await store.read()).toEqual({ views: { compact: "details" } });
    expect(documentsViewWriteRpc.input.parse({ layout: "wide", view: "tree" })).toEqual({ layout: "wide", view: "tree" });
    expect(documentsViewReadRpc.output.parse(await store.write("wide", "tree"))).toEqual({ views: { compact: "details", wide: "tree" } });
  });

  it("merges writes from two stores on one folder, as daemons sharing it do", async () => {
    const directory = join(workspace(), "state");
    const [one, two] = [new DocumentViewStore(directory), new DocumentViewStore(directory)];
    for (const view of ["previews", "details", "list"] as const) {
      await Promise.all([one.write("wide", view), two.write("compact", view)]);
      expect(await new DocumentViewStore(directory).read()).toEqual({ views: { compact: view, wide: view } });
    }
    expect(existsSync(join(directory, "documents-view.lock"))).toBe(false);
  });

  it("reads a view it does not know as unchosen for that layout only, and a write keeps it", async () => {
    const directory = workspace();
    const store = new DocumentViewStore(directory);
    writeFileSync(join(directory, "documents-view.json"), JSON.stringify({ version: 1, views: { wide: "gallery", compact: "details" } }));
    expect(await store.read()).toEqual({ views: { compact: "details" } });
    expect(await store.write("compact", "list")).toEqual({ views: { compact: "list" } });
    expect(saved(directory)).toEqual({ version: 1, views: { wide: "gallery", compact: "list" } });
  });

  it("keeps a later version's number, views and fields when it writes", async () => {
    const directory = workspace();
    const store = new DocumentViewStore(directory);
    const later = { version: 2, views: { wide: "previews", tablet: "grid" }, sort: { wide: "name" } };
    writeFileSync(join(directory, "documents-view.json"), JSON.stringify(later));
    expect(await store.read()).toEqual({ views: { wide: "previews" } });
    expect(await store.write("compact", "details")).toEqual({ views: { wide: "previews", compact: "details" } });
    expect(saved(directory)).toEqual({ ...later, views: { ...later.views, compact: "details" } });
  });

  it("reads a damaged file as nothing chosen and keeps it aside as .bad when it writes", async () => {
    const directory = workspace();
    const store = new DocumentViewStore(directory);
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    for (const damaged of ["{ not json", "[]", JSON.stringify({ version: 1, views: "list" })]) {
      writeFileSync(join(directory, "documents-view.json"), damaged);
      expect(await store.read()).toEqual({ views: {} });
      expect(await store.write("compact", "list")).toEqual({ views: { compact: "list" } });
      expect(readFileSync(join(directory, "documents-view.json.bad"), "utf8")).toBe(damaged);
      expect(saved(directory)).toEqual({ version: 1, views: { compact: "list" } });
    }
    expect(logged).toHaveBeenCalledTimes(3);
    logged.mockRestore();
  });
});
