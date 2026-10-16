import { useCallback, useEffect, useState } from "react";
import { type LayoutChangeEvent, PixelRatio } from "react-native";
import { renderWidthFor } from "./paging";

const RESIZE_SETTLE_MS = 250;

export function useFitWidth(inset = 0, zoom = 1) {
  const [layoutWidth, setLayoutWidth] = useState(0);
  const [settledWidth, setSettledWidth] = useState(0);

  useEffect(() => {
    if (layoutWidth === settledWidth) return;
    const timer = setTimeout(() => setSettledWidth(layoutWidth), settledWidth === 0 ? 0 : RESIZE_SETTLE_MS);
    return () => clearTimeout(timer);
  }, [layoutWidth, settledWidth]);

  const onLayout = useCallback(
    (event: LayoutChangeEvent) => setLayoutWidth(Math.max(0, Math.floor(event.nativeEvent.layout.width - inset))),
    [inset],
  );

  return { contentWidth: layoutWidth, requestWidth: renderWidthFor(settledWidth, PixelRatio.get(), zoom), onLayout };
}
