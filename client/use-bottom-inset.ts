import { useCallback, useRef, useState } from "react";
import { Dimensions, Platform, TurboModuleRegistry, useWindowDimensions, type View } from "react-native";
import { bottomInsetFor, navBarHeightFrom } from "./insets";

let navBarHeight: number | null | undefined;

function androidNavBarHeight(): number | null {
  if (navBarHeight === undefined) {
    try {
      navBarHeight = navBarHeightFrom(TurboModuleRegistry.get("RNCSafeAreaContext")?.getConstants?.());
    } catch {
      navBarHeight = null;
    }
  }
  return navBarHeight;
}

export function useBottomInset() {
  const ref = useRef<View>(null);
  const [frameBottom, setFrameBottom] = useState<number | null>(null);
  const window = useWindowDimensions();
  const onLayout = useCallback(() => {
    if (Platform.OS !== "android") return;
    ref.current?.measure((_x, _y, _width, height, _pageX, pageY) => setFrameBottom(pageY + height));
  }, []);
  const screenHeight = Math.max(window.height, Dimensions.get("screen").height);
  return {
    ref,
    onLayout,
    bottomInset: bottomInsetFor({
      os: Platform.OS,
      frameBottom,
      screenHeight,
      navBarHeight: Platform.OS === "android" ? androidNavBarHeight() : null,
    }),
  };
}
