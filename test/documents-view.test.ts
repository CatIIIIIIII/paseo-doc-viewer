import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DocumentViewStore } from "../server/documents-view";
import { documentsViewReadRpc, documentsViewWriteRpc } from "../shared/rpc";
import { workspace } from "./helpers";

describe("Documents view store", () => {
  it("keeps one view per layout class for every store on the folder", async () => {
    const directory = join(workspace(), "state");
    const store = new DocumentViewStore(directory);
    expect(await store.read()).toEqual({ views: {} });
    expect(documentsViewWriteRpc.output.parse(await store.write("wide", "previews"))).toEqual({ views: { wide: "previews" } });
    await Promise.all([store.write("compact", "details"), store.write("wide", "details")]);
    expect(documentsViewReadRpc.output.parse(await new DocumentViewStore(directory).read())).toEqual({ views: { compact: "details", wide: "details" } });
    expect(JSON.parse(readFileSync(join(directory, "documents-view.json"), "utf8"))).toEqual({ version: 1, views: { compact: "details", wide: "details" } });
    expect(statSync(join(directory, "documents-view.json")).mode & 0o777).toBe(0o600);
  });

  it("reads an unreadable or unknown file as nothing chosen, and a write replaces it", async () => {
    const directory = workspace();
    const store = new DocumentViewStore(directory);
    writeFileSync(join(directory, "documents-view.json"), "{ not json");
    expect(await store.read()).toEqual({ views: {} });
    writeFileSync(join(directory, "documents-view.json"), JSON.stringify({ version: 1, views: { wide: "gallery" } }));
    expect(await store.read()).toEqual({ views: {} });
    expect(await store.write("compact", "list")).toEqual({ views: { compact: "list" } });
  });
});
