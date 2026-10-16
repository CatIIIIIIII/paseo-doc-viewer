export const ANDROID_NAV_BAR_DP = 48;

export function bottomInsetFor({
  os,
  frameBottom,
  screenHeight,
}: {
  os: string;
  frameBottom: number | null;
  screenHeight: number;
}): number {
  if (os !== "android" || frameBottom === null || !(screenHeight > 0)) return 0;
  const overlap = frameBottom - (screenHeight - ANDROID_NAV_BAR_DP);
  return Math.round(Math.min(ANDROID_NAV_BAR_DP, Math.max(0, overlap)));
}
