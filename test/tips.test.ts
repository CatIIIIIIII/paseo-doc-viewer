import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { afterNext, tipControls, TIPS, visibleTip } from "../client/tips";
import { TipsStore } from "../server/tips";
import { tipsDismissRpc, tipsReadRpc } from "../shared/rpc";
import { workspace } from "./helpers";

describe("first-run tips store", () => {
  it("is not dismissed until dismissed, then stays dismissed for every store on the folder", async () => {
    const directory = join(workspace(), "state");
    const store = new TipsStore(directory);
    expect(await store.read()).toEqual({ dismissed: false });
    expect(tipsDismissRpc.output.parse(await store.dismiss(1000))).toEqual({ dismissed: true });
    expect(tipsReadRpc.output.parse(await store.read())).toEqual({ dismissed: true });
    // Another client of the daemon, or a restarted daemon, reads the same file.
    expect(await new TipsStore(directory).read()).toEqual({ dismissed: true });
    expect(JSON.parse(readFileSync(join(directory, "tips.json"), "utf8"))).toEqual({ version: 1, dismissedAt: 1000 });
    expect(statSync(join(directory, "tips.json")).mode & 0o777).toBe(0o600);
  });

  it("shows the tips again when the file is unreadable, and a dismiss repairs it", async () => {
    const directory = workspace();
    const store = new TipsStore(directory);
    writeFileSync(join(directory, "tips.json"), "{ not json");
    expect(await store.read()).toEqual({ dismissed: false });
    writeFileSync(join(directory, "tips.json"), JSON.stringify({ version: 2, dismissedAt: 5 }));
    expect(await store.read()).toEqual({ dismissed: false });
    await Promise.all([store.dismiss(), store.dismiss(), new TipsStore(directory).dismiss()]);
    expect(await store.read()).toEqual({ dismissed: true });
  });
});

describe("first-run tips in the panel", () => {
  it("shows nothing until the server answers, the first tip when not dismissed, and what was pressed after that", () => {
    expect(visibleTip(undefined, null)).toBeNull();
    expect(visibleTip(true, null)).toBeNull();
    expect(visibleTip(false, null)).toBe(0);
    expect(visibleTip(false, "closed")).toBeNull();
    // Reopening from the Tips link shows the first tip even though the server says dismissed.
    expect(visibleTip(true, { step: 0 })).toBe(0);
    expect(visibleTip(undefined, { step: 2 })).toBe(2);
  });

  it("steps through every tip with Next, then Done dismisses; Skip is offered on all but the last", () => {
    const seen: string[] = [];
    let step: number | null = 0;
    while (step !== null) {
      const controls = tipControls(step);
      seen.push(`${controls.progress} ${controls.next}${controls.skip ? " +Skip" : ""}`);
      const after = afterNext(step);
      expect(after.dismiss).toBe(after.choice === "closed");
      step = after.choice === "closed" || after.choice === null ? null : after.choice.step;
    }
    expect(seen).toEqual(["1 of 4 Next +Skip", "2 of 4 Next +Skip", "3 of 4 Next +Skip", "4 of 4 Done"]);
  });

  it("keeps each tip short enough for a phone card", () => {
    expect(TIPS.length).toBeGreaterThanOrEqual(3);
    expect(TIPS.length).toBeLessThanOrEqual(4);
    for (const tip of TIPS) {
      expect(tip.title.length).toBeLessThanOrEqual(24);
      expect(tip.text.length).toBeLessThanOrEqual(140);
      expect(`${tip.title} ${tip.text}`).not.toMatch(/\u2014/);
    }
  });
});
