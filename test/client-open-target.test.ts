import { describe, expect, it } from "vitest";
import { type OpenContext, openTarget, SIDE_BY_SIDE_MIN_WINDOW } from "../client/open-target";
import { createPanelReader } from "../client/panel-reader";

const wide: OpenContext = { compact: false, panelVisible: false, preference: undefined, windowWidth: 1440 };

describe("openTarget", () => {
  it("opens phones on the full screen, even with Documents mounted", () => {
    expect(openTarget({ ...wide, compact: true, windowWidth: 390 })).toBe("screen");
    expect(openTarget({ ...wide, compact: true, panelVisible: true, preference: "side" })).toBe("screen");
  });

  it("shows the document in a Documents panel already on screen, whatever the preference", () => {
    for (const preference of [undefined, "auto", "side", "full"] as const) {
      expect(openTarget({ ...wide, panelVisible: true, preference, windowWidth: 900 })).toBe("in-place");
    }
  });

  it("follows the preference when no panel is on screen", () => {
    expect(openTarget({ ...wide, preference: "side", windowWidth: 900 })).toBe("explorer");
    expect(openTarget({ ...wide, preference: "full" })).toBe("screen");
  });

  it("reads an unanswered preference as auto: side by side from the threshold width", () => {
    expect(openTarget({ ...wide, windowWidth: SIDE_BY_SIDE_MIN_WINDOW })).toBe("explorer");
    expect(openTarget({ ...wide, windowWidth: SIDE_BY_SIDE_MIN_WINDOW - 1 })).toBe("screen");
    expect(openTarget({ ...wide, preference: "auto", windowWidth: SIDE_BY_SIDE_MIN_WINDOW - 1 })).toBe("screen");
  });
});

describe("panel reader visibility", () => {
  it("counts a mounted Documents panel as on screen only while it has a width", () => {
    const reader = createPanelReader();
    const panel = {};
    expect(reader.visible("ws")).toBe(false);
    reader.measured(panel, "ws", 320);
    expect(reader.visible("ws")).toBe(true);
    expect(reader.visible("other")).toBe(false);
    reader.measured(panel, "ws", 0);
    expect(reader.visible("ws")).toBe(false);
    reader.measured(panel, "ws", 560);
    reader.unmounted(panel);
    expect(reader.visible("ws")).toBe(false);
  });
});
