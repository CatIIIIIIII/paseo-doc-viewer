import { describe, expect, it } from "vitest";
import { colorSchemeFor, fittedBox } from "../client/media";

describe("media control color scheme", () => {
  it("follows the luminance of the theme background", () => {
    expect(colorSchemeFor("#ffffff")).toBe("light");
    expect(colorSchemeFor("#fafafa")).toBe("light");
    expect(colorSchemeFor("#111827")).toBe("dark");
    expect(colorSchemeFor("#000")).toBe("dark");
    expect(colorSchemeFor("#18181bff")).toBe("dark");
    expect(colorSchemeFor("rgb(250, 250, 250)")).toBe("light");
    expect(colorSchemeFor("rgba(9, 9, 11, 1)")).toBe("dark");
  });

  it("leaves the browser default for colors it cannot read", () => {
    expect(colorSchemeFor("canvas")).toBeUndefined();
    expect(colorSchemeFor("hsl(0 0% 100%)")).toBeUndefined();
  });
});

describe("video box", () => {
  it("fits the clip's aspect ratio inside the frame", () => {
    expect(fittedBox({ width: 1000, height: 1000 }, 16 / 9)).toEqual({ width: 1000, height: 563 });
    expect(fittedBox({ width: 1000, height: 400 }, 16 / 9)).toEqual({ width: 711, height: 400 });
    expect(fittedBox({ width: 360, height: 600 }, 9 / 16)).toEqual({ width: 338, height: 600 });
  });

  it("is empty until the frame and ratio are known", () => {
    expect(fittedBox({ width: 0, height: 400 }, 1.5)).toEqual({ width: 0, height: 0 });
  });
});
