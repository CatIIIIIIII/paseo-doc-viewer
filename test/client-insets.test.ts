import { describe, expect, it } from "vitest";
import { ANDROID_NAV_BAR_DP, bottomInsetFor } from "../client/insets";

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
});
