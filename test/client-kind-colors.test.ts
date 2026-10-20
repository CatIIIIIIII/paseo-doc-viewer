import { describe, expect, it } from "vitest";
import { contrast, GROUP_COLOR, kindColor, kindPalette, parseColor } from "../client/kind-colors";
import { entryLabel } from "../client/recent";
import { DOCUMENT_GROUPS } from "../shared/browse";

const colors = (surface0: string, surface2: string, foregroundMuted: string) =>
  ({ surface0, surface1: surface0, surface2, border: surface2, foreground: "#fff", foregroundMuted, accent: "#000", accentForeground: "#fff", statusSuccess: "#0f0", statusWarning: "#fa0", statusDanger: "#f00" });

const LIGHT = [colors("#ffffff", "#f4f4f5", "#71717a")];
const DARK = [
  colors("#181B1A", "#272A29", "#A1A5A4"),
  colors("#18181b", "#27272a", "#a1a1aa"),
  colors("#161820", "#252731", "#9a9db0"),
  colors("#1f1f1e", "#2f2d2b", "#ada9a5"),
  colors("#282c34", "#383c48", "#c8ccd8"),
];

describe("kind colors", () => {
  it("parses the color forms themes use", () => {
    expect(parseColor("#fff")).toEqual([255, 255, 255]);
    expect(parseColor("#20744A")).toEqual([32, 116, 74]);
    expect(parseColor("#20744Acc")).toEqual([32, 116, 74]);
    expect(parseColor("rgba(10, 20, 30, 0.5)")).toEqual([10, 20, 30]);
    expect(parseColor("teal")).toBeNull();
  });

  it("picks the set by surface luminance and keeps every color on the built-in themes", () => {
    for (const theme of LIGHT) {
      const palette = kindPalette(theme, true);
      for (const group of DOCUMENT_GROUPS) expect(palette[group]).toBe(GROUP_COLOR[group].light);
    }
    for (const theme of DARK) {
      const palette = kindPalette(theme, true);
      for (const group of DOCUMENT_GROUPS) {
        expect(palette[group]).toBe(GROUP_COLOR[group].dark);
        expect(contrast(parseColor(palette[group])!, parseColor(theme.surface2)!)).toBeGreaterThanOrEqual(3);
      }
    }
  });

  it("falls back to the muted foreground under 3:1, when off, or for colors it cannot read", () => {
    const grey = kindPalette(colors("#777777", "#777777", "#111111"), true);
    expect(DOCUMENT_GROUPS.filter((group) => grey[group] !== "#111111")).toEqual([]);
    const off = kindPalette(DARK[0]!, false);
    expect(new Set(Object.values(off))).toEqual(new Set(["#A1A5A4"]));
    expect(kindPalette(colors("var(--bg)", "#272A29", "#999"), true).pdf).toBe("#999");
  });

  it("maps kinds through their group", () => {
    const palette = kindPalette(DARK[0]!, true);
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
