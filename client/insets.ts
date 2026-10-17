export const ANDROID_NAV_BAR_DP = 48;

// Reads the bottom inset from react-native-safe-area-context's native constants
// (initialWindowMetrics), which the host app registers. The plugin SDK exposes no
// safe-area insets, and Paseo draws edge-to-edge, so window height equals screen
// height and gives no hint of the navigation bar. Null when unavailable or zero.
export function navBarHeightFrom(constants: unknown): number | null {
  const bottom = (constants as { initialWindowMetrics?: { insets?: { bottom?: unknown } } } | null | undefined)
    ?.initialWindowMetrics?.insets?.bottom;
  return typeof bottom === "number" && Number.isFinite(bottom) && bottom > 0 ? bottom : null;
}

export type SafeAreaHook = () => { bottom: number };

// Paseo 0.11.2 does not export useSafeAreaInsets; a host that does gives live insets.
export function safeAreaHookFrom(sdk: unknown): SafeAreaHook | null {
  const hook = (sdk as { useSafeAreaInsets?: unknown } | null | undefined)?.useSafeAreaInsets;
  return typeof hook === "function" ? (hook as SafeAreaHook) : null;
}

// frameBottom must be in screen coordinates (measure pageY + height). measureInWindow
// on Android reports y relative to the area below the status bar, so it falls short.
export function bottomInsetFor({
  os,
  frameBottom,
  screenHeight,
  navBarHeight = null,
}: {
  os: string;
  frameBottom: number | null;
  screenHeight: number;
  navBarHeight?: number | null;
}): number {
  if (os !== "android" || frameBottom === null || !(screenHeight > 0)) return 0;
  const navBar = navBarHeight ?? ANDROID_NAV_BAR_DP;
  const overlap = frameBottom - (screenHeight - navBar);
  return Math.round(Math.min(navBar, Math.max(0, overlap)));
}

// Both values in screen coordinates: measure pageY + height, and the keyboard event's endCoordinates.screenY.
export function keyboardInsetFor({ frameBottom, keyboardTop }: { frameBottom: number | null; keyboardTop: number | null }): number {
  if (frameBottom === null || keyboardTop === null) return 0;
  return Math.round(Math.max(0, frameBottom - keyboardTop));
}
