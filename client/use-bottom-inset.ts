import { useCallback, useRef, useState } from "react";
import { Dimensions, Platform, useWindowDimensions, type View } from "react-native";
import { bottomInsetFor } from "./insets";

export function useBottomInset() {
  const ref = useRef<View>(null);
  const [frameBottom, setFrameBottom] = useState<number | null>(null);
  const window = useWindowDimensions();
  const onLayout = useCallback(() => {
    if (Platform.OS !== "android") return;
    ref.current?.measureInWindow((_x, y, _width, height) => setFrameBottom(y + height));
  }, []);
  const screenHeight = Math.max(window.height, Dimensions.get("screen").height);
  return { ref, onLayout, bottomInset: bottomInsetFor({ os: Platform.OS, frameBottom, screenHeight }) };
}
