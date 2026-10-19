import type { PluginTheme } from "@getpaseo/plugin";
import { DOCUMENT_GROUPS, type DocumentGroup, KIND_GROUP } from "../shared/browse";
import type { DocumentKind } from "../shared/kinds";

// One hue per group, for file icons only. Checked with simulated protan, deutan and tritan vision
// (Machado 2009, CIEDE2000): no two groups fall under a difference of 10 in either set. Lightness is
// spread on purpose, since it is the one axis all three keep.
export const GROUP_COLOR: { readonly [G in DocumentGroup]: { light: string; dark: string } } = {
  pdf: { light: "#ed4857", dark: "#ea9893" },
  word: { light: "#4a7add", dark: "#6e8be6" },
  excel: { light: "#2b9464", dark: "#8ff99c" },
  powerpoint: { light: "#7a2e0c", dark: "#b48044" },
  image: { light: "#7824aa", dark: "#e6b1ff" },
  video: { light: "#0a6c80", dark: "#4cbbbb" },
  audio: { light: "#7c6713", dark: "#b8be48" },
};

// The theme has no appearance flag, so a dark surface is told by its luminance.
const DARK_SURFACE_LUMINANCE = 0.18;
// WCAG 1.4.11 for graphics; an icon under it takes the muted foreground instead.
const MIN_ICON_CONTRAST = 3;

type Rgb = readonly [number, number, number];

export function parseColor(value: string): Rgb | null {
  const hex = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(value.trim())?.[1];
  if (hex) {
    const full = hex.length <= 4 ? Array.from(hex, (digit) => digit + digit).join("") : hex;
    return [parseInt(full.slice(0, 2), 16), parseInt(full.slice(2, 4), 16), parseInt(full.slice(4, 6), 16)];
  }
  const rgb = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/i.exec(value.trim());
  return rgb ? [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])] : null;
}

export function luminance([r, g, b]: Rgb): number {
  const channel = (value: number) => {
    const c = value / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

export function contrast(a: Rgb, b: Rgb): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light! + 0.05) / (dark! + 0.05);
}

export type KindPalette = { readonly [G in DocumentGroup]: string };

export function kindPalette(colors: PluginTheme["colors"], enabled: boolean): KindPalette {
  const surface = parseColor(colors.surface0);
  const hover = parseColor(colors.surface2);
  const tone = surface && luminance(surface) < DARK_SURFACE_LUMINANCE ? "dark" : "light";
  const legible = (color: string) => {
    const rgb = parseColor(color)!;
    return surface !== null && hover !== null && contrast(rgb, surface) >= MIN_ICON_CONTRAST && contrast(rgb, hover) >= MIN_ICON_CONTRAST;
  };
  return Object.fromEntries(
    DOCUMENT_GROUPS.map((group) => {
      const color = GROUP_COLOR[group][tone];
      return [group, enabled && legible(color) ? color : colors.foregroundMuted];
    }),
  ) as KindPalette;
}

export const kindColor = (palette: KindPalette, kind: DocumentKind) => palette[KIND_GROUP[kind]];
