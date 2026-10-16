import { describe, expect, it } from "vitest";
import { FLING_SECONDS, flingOffset, keepsResponder, panOffset, responderClaim } from "../client/paging";

describe("zoomed page gestures", () => {
  it("claims a single finger as a pan only when the page is zoomed in", () => {
    expect(responderClaim({ touches: 1, zoom: 2, pinchable: true })).toBe("pan");
    expect(responderClaim({ touches: 1, zoom: 1, pinchable: true })).toBeNull();
  });

  it("claims two fingers as a pinch at any zoom", () => {
    expect(responderClaim({ touches: 2, zoom: 1, pinchable: true })).toBe("pinch");
    expect(responderClaim({ touches: 3, zoom: 2, pinchable: true })).toBe("pinch");
  });

  it("claims nothing where pinch zoom is off (web, text view, no page yet)", () => {
    expect(responderClaim({ touches: 1, zoom: 2, pinchable: false })).toBeNull();
    expect(responderClaim({ touches: 2, zoom: 2, pinchable: false })).toBeNull();
    expect(responderClaim({ touches: 0, zoom: 2, pinchable: true })).toBeNull();
  });

  it("refuses to hand the touch to another responder during a pan or pinch", () => {
    expect(keepsResponder(null)).toBe(false);
    expect(keepsResponder("pan")).toBe(true);
    expect(keepsResponder("pinch")).toBe(true);
  });

  it("moves the content against the finger and stops at the edges", () => {
    expect(panOffset(300, -100, 2000, 400)).toBe(400);
    expect(panOffset(300, 100, 2000, 400)).toBe(200);
    expect(panOffset(50, 100, 2000, 400)).toBe(0);
    expect(panOffset(1500, -200, 2000, 400)).toBe(1600);
  });

  it("carries a released pan on by its velocity, within the content", () => {
    expect(flingOffset(500, -2, 4000, 400)).toBe(500 + 2000 * FLING_SECONDS);
    expect(flingOffset(500, 2, 4000, 400)).toBe(Math.max(0, 500 - 2000 * FLING_SECONDS));
    expect(flingOffset(3500, -5, 4000, 400)).toBe(3600);
    expect(flingOffset(500, 0, 4000, 400)).toBe(500);
  });
});
