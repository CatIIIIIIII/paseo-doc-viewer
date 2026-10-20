import { describe, expect, it } from "vitest";
import { contrast, GROUP_COLOR, kindColor, kindPalette, parseColor } from "../client/kind-colors";
import { entryLabel } from "../client/recent";
import { DOCUMENT_GROUPS } from "../shared/browse";

const colors = (surface0: string, surface1: string, surface2: string, foregroundMuted: string) =>
  ({ surface0, surface1, surface2, border: surface2, foreground: "#fff", foregroundMuted, accent: "#000", accentForeground: "#fff", statusSuccess: "#0f0", statusWarning: "#fa0", statusDanger: "#f00" });

// The surfaces and muted foreground of Paseo's built-in themes.
const THEMES = {
  light: colors("#ffffff", "#fafafa", "#f4f4f5", "#71717a"),
  dark: colors("#181B1A", "#1E2120", "#272A29", "#A1A5A4"),
  zinc: colors("#18181b", "#1f1f22", "#27272a", "#a1a1aa"),
  midnight: colors("#161820", "#1c1e27", "#252731", "#9a9db0"),
  claude: colors("#1f1f1e", "#262523", "#2f2d2b", "#ada9a5"),
  ghostty: colors("#282c34", "#2f333d", "#383c48", "#c8ccd8"),
  pureBlack: colors("#000000", "#0a0a0a", "#111111", "#a1a1aa"),
};

describe("kind colors", () => {
  it("parses the color forms themes use", () => {
    expect(parseColor("#fff")).toEqual([255, 255, 255]);
    expect(parseColor("#20744A")).toEqual([32, 116, 74]);
    expect(parseColor("#20744Acc")).toEqual([32, 116, 74]);
    expect(parseColor("rgba(10, 20, 30, 0.5)")).toEqual([10, 20, 30]);
    expect(parseColor("teal")).toBeNull();
  });

  it.each(Object.entries(THEMES))("keeps every color of its set at 3:1 on each surface of the %s theme", (name, theme) => {
    const palette = kindPalette(theme, true);
    for (const group of DOCUMENT_GROUPS) {
      expect(palette[group]).toBe(GROUP_COLOR[group][name === "light" ? "light" : "dark"]);
      for (const surface of [theme.surface0, theme.surface1, theme.surface2]) {
        expect(contrast(parseColor(palette[group])!, parseColor(surface)!)).toBeGreaterThanOrEqual(3);
      }
    }
  });

  it("falls back to the muted foreground under 3:1, when off, or for colors it cannot read", () => {
    const grey = kindPalette(colors("#777777", "#777777", "#777777", "#111111"), true);
    expect(DOCUMENT_GROUPS.filter((group) => grey[group] !== "#111111")).toEqual([]);
    for (const theme of [THEMES.light, THEMES.pureBlack]) expect(new Set(Object.values(kindPalette(theme, false)))).toEqual(new Set([theme.foregroundMuted]));
    expect(kindPalette(colors("var(--bg)", "#1E2120", "#272A29", "#999"), true).pdf).toBe("#999");
  });

  it("maps kinds through their group", () => {
    const palette = kindPalette(THEMES.dark, true);
    expect(kindColor(palette, "csv")).toBe(GROUP_COLOR.excel.dark);
    expect(kindColor(palette, "image-decoded")).toBe(GROUP_COLOR.image.dark);
  });
});

describe("entry labels", () => {
  const now = Date.UTC(2026, 9, 19, 12);
  it("lead with the file name, then kind, folder, time and status", () => {
    expect(entryLabel({ path: "docs/q3/report.pdf", kind: "pdf", mtimeMs: now - 3 * 60_000, size: 1, revision: "r", review: "changed" }, now))
      .toBe("report.pdf, PDF, in docs/q3, changed 3 min ago, changed since review");
    expect(entryLabel({ path: "deck.pptx", kind: "pptx", mtimeMs: now, size: 1, revision: "r", isNew: true }, now, ["2.4 MB"]))
      .toBe("deck.pptx, Presentation, changed just now, 2.4 MB, new");
  });
});
