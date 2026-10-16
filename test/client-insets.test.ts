import { describe, expect, it } from "vitest";
import { ANDROID_NAV_BAR_DP, bottomInsetFor, keyboardInsetFor, navBarHeightFrom } from "../client/insets";

describe("bottom inset", () => {
  it("pads an Android view that reaches the bottom of the screen by the navigation bar height", () => {
    expect(bottomInsetFor({ os: "android", frameBottom: 844, screenHeight: 844 })).toBe(ANDROID_NAV_BAR_DP);
  });

  it("pads only the part of the navigation bar the view overlaps", () => {
    expect(bottomInsetFor({ os: "android", frameBottom: 844 - ANDROID_NAV_BAR_DP + 10, screenHeight: 844 })).toBe(10);
    expect(bottomInsetFor({ os: "android", frameBottom: 600, screenHeight: 844 })).toBe(0);
  });

  it("never pads more than the navigation bar", () => {
    expect(bottomInsetFor({ os: "android", frameBottom: 900, screenHeight: 844 })).toBe(ANDROID_NAV_BAR_DP);
  });

  it("does not pad before the view is measured, or on other platforms", () => {
    expect(bottomInsetFor({ os: "android", frameBottom: null, screenHeight: 844 })).toBe(0);
    expect(bottomInsetFor({ os: "ios", frameBottom: 844, screenHeight: 844 })).toBe(0);
    expect(bottomInsetFor({ os: "web", frameBottom: 844, screenHeight: 844 })).toBe(0);
  });

  // Pixel 10 Pro, 3-button nav, edge-to-edge host: window and screen are both 1083.1 dp.
  // measureInWindow put the panel at y=63.8 (below the 77.3 dp status bar), bottom 1005.8,
  // so the old rule padded 0. measure pageY gives 141.1 + 942.0 = 1083.1.
  it("pads by the navigation bar when the frame bottom is in screen coordinates", () => {
    const screenHeight = 1083.146;
    expect(bottomInsetFor({ os: "android", frameBottom: 63.82 + 942.02, screenHeight })).toBe(0);
    expect(bottomInsetFor({ os: "android", frameBottom: 141.12 + 942.02, screenHeight, navBarHeight: 48.09 })).toBe(48);
  });

  it("uses the reported navigation bar height, so gesture navigation pads less", () => {
    expect(bottomInsetFor({ os: "android", frameBottom: 844, screenHeight: 844, navBarHeight: 24 })).toBe(24);
    expect(bottomInsetFor({ os: "android", frameBottom: 830, screenHeight: 844, navBarHeight: 24 })).toBe(10);
    expect(bottomInsetFor({ os: "android", frameBottom: 800, screenHeight: 844, navBarHeight: 24 })).toBe(0);
    expect(bottomInsetFor({ os: "android", frameBottom: 844, screenHeight: 844, navBarHeight: null })).toBe(ANDROID_NAV_BAR_DP);
  });

  it("reads the bottom inset from the safe-area native constants", () => {
    const constants = (bottom: unknown) => ({ initialWindowMetrics: { frame: {}, insets: { top: 77.3, bottom } } });
    expect(navBarHeightFrom(constants(48.09))).toBe(48.09);
    expect(navBarHeightFrom(constants(24))).toBe(24);
    expect(navBarHeightFrom(constants(0))).toBeNull();
    expect(navBarHeightFrom(constants("48"))).toBeNull();
    expect(navBarHeightFrom({})).toBeNull();
    expect(navBarHeightFrom(undefined)).toBeNull();
    expect(navBarHeightFrom(null)).toBeNull();
  });
});

describe("keyboard inset", () => {
  it("pads a view by the part the keyboard covers, both in screen coordinates", () => {
    expect(keyboardInsetFor({ frameBottom: 1083, keyboardTop: 700 })).toBe(383);
    expect(keyboardInsetFor({ frameBottom: 1035.4, keyboardTop: 700 })).toBe(335);
  });

  it("does not pad a view that ends above the keyboard, or when the keyboard is hidden or the view unmeasured", () => {
    expect(keyboardInsetFor({ frameBottom: 650, keyboardTop: 700 })).toBe(0);
    expect(keyboardInsetFor({ frameBottom: 1083, keyboardTop: null })).toBe(0);
    expect(keyboardInsetFor({ frameBottom: null, keyboardTop: 700 })).toBe(0);
  });
});
