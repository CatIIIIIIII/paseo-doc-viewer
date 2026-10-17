import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { pinStatus } from "../client/pins";
import { readViewerState, setPin, ViewerStateStore } from "../server/viewer-state";
import { PIN_LABEL_MAX_CHARS, PINS_MAX_PER_FILE } from "../shared/limits";
import { viewerStatePinRpc } from "../shared/rpc";
import { workspace } from "./helpers";

const position = { type: "page" as const, index: 4, zoom: 2, text: false };

describe("page pins", () => {
  it("keeps pins beside the reading position, with an optional label and the revision at creation", async () => {
    const root = workspace({ "report.pdf": "%PDF-1.4" });
    const directory = workspace();
    const store = new ViewerStateStore(directory);
    await store.write(await store.key(root, "report.pdf"), position);
    expect(await setPin(store, root, "report.pdf", 11, { label: "  Forecast  ", revision: "r1" })).toEqual({
      pins: [{ index: 11, label: "Forecast", revision: "r1" }],
    });
    await setPin(store, root, "report.pdf", 2, { revision: "r1" });
    await store.write(await store.key(root, "report.pdf"), { ...position, index: 7 });
    const reopened = await readViewerState(new ViewerStateStore(directory), root, "report.pdf");
    expect(reopened).toMatchObject({ saved: { position: { index: 7 } }, pins: [{ index: 2, revision: "r1" }, { index: 11, label: "Forecast" }] });
    expect(reopened.pins[0]).not.toHaveProperty("label");
    expect(readFileSync(join(directory, "positions.json"), "utf8")).toContain("Forecast");
  });

  it("confirms a pin by pinning the page again and removes it on request", async () => {
    const root = workspace({ "report.pdf": "%PDF-1.4" });
    const store = new ViewerStateStore(workspace());
    await setPin(store, root, "report.pdf", 3, { label: "Appendix", revision: "r1" });
    expect((await setPin(store, root, "report.pdf", 3, { label: "Appendix", revision: "r2" })).pins).toEqual([{ index: 3, label: "Appendix", revision: "r2" }]);
    expect((await setPin(store, root, "report.pdf", 3, null)).pins).toEqual([]);
    expect(await store.read(await store.key(root, "report.pdf"))).toBeNull();
  });

  it("refuses more pins than the per-file bound instead of dropping one silently", async () => {
    const root = workspace({ "report.pdf": "%PDF-1.4" });
    const store = new ViewerStateStore(workspace());
    for (let index = 0; index < PINS_MAX_PER_FILE; index++) await setPin(store, root, "report.pdf", index, { revision: "r1" });
    await expect(setPin(store, root, "report.pdf", PINS_MAX_PER_FILE, { revision: "r1" })).rejects.toThrow(/up to/i);
    expect((await setPin(store, root, "report.pdf", 0, { label: "still editable", revision: "r1" })).pins).toHaveLength(PINS_MAX_PER_FILE);
  });

  it("bounds labels and revisions in the RPC schema and refuses paths outside the workspace", async () => {
    const input = { workspaceId: "w", path: "a.pdf", index: 0 };
    expect(viewerStatePinRpc.input.safeParse({ ...input, pin: { label: "x".repeat(PIN_LABEL_MAX_CHARS), revision: "r" } }).success).toBe(true);
    expect(viewerStatePinRpc.input.safeParse({ ...input, pin: { label: "x".repeat(PIN_LABEL_MAX_CHARS + 1), revision: "r" } }).success).toBe(false);
    expect(viewerStatePinRpc.input.safeParse({ ...input, pin: { revision: "r".repeat(65) } }).success).toBe(false);
    expect(viewerStatePinRpc.input.safeParse({ ...input, pin: null }).success).toBe(true);
    await expect(setPin(new ViewerStateStore(workspace()), workspace(), "../x.pdf", 0, { revision: "r" })).rejects.toThrow(/outside/);
  });

  it("tells the user when a pin may need checking or its page is gone", () => {
    expect(pinStatus({ index: 2, revision: "r1" }, "r1", 10)).toBe("current");
    expect(pinStatus({ index: 2, revision: "r1" }, "r2", 10)).toBe("changed");
    expect(pinStatus({ index: 12, revision: "r1" }, "r2", 10)).toBe("missing");
  });
});
