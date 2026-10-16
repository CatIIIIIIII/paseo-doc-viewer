import { type RefObject, useEffect, useState } from "react";
import { Keyboard, Platform, type View } from "react-native";
import { keyboardInsetFor } from "./insets";

export function useKeyboardInset(ref: RefObject<View | null>): number {
  const [inset, setInset] = useState(0);
  useEffect(() => {
    if (Platform.OS !== "ios" && Platform.OS !== "android") return;
    const cover = (keyboardTop: number) =>
      ref.current?.measure((_x, _y, _width, height, _pageX, pageY) => setInset(keyboardInsetFor({ frameBottom: pageY + height, keyboardTop })));
    const ios = Platform.OS === "ios";
    const shown = Keyboard.addListener(ios ? "keyboardWillShow" : "keyboardDidShow", (event) => cover(event.endCoordinates.screenY));
    const hidden = Keyboard.addListener(ios ? "keyboardWillHide" : "keyboardDidHide", () => setInset(0));
    const open = Keyboard.isVisible() ? Keyboard.metrics() : undefined;
    if (open) cover(open.screenY);
    return () => {
      shown.remove();
      hidden.remove();
    };
  }, [ref]);
  return inset;
}
