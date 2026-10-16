import { useRef, useState } from "react";
import {
  type GestureResponderEvent,
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  type NativeTouchEvent,
  Platform,
  type ScrollView,
  type View,
} from "react-native";
import { clampOffset, clampZoom, focalOffset, pinchScale, scaleShift, tapZoom } from "./paging";

const PENDING_SCROLL_MS = 500;
const TAP_MS = 250;
const TAP_SLOP_DP = 10;
const DOUBLE_TAP_MS = 300;
const DOUBLE_TAP_SLOP_DP = 30;

type Point = { x: number; y: number };
type Live = { scale: number; shift: Point };
type Pinch = { distance: number; anchor: Point; focal: Point; scale: number };
type Touch = { at: number; point: Point };

const midpoint = (a: NativeTouchEvent, b: NativeTouchEvent): Point => ({ x: (a.pageX + b.pageX) / 2, y: (a.pageY + b.pageY) / 2 });
const distance = (a: NativeTouchEvent, b: NativeTouchEvent) => Math.hypot(a.pageX - b.pageX, a.pageY - b.pageY);
const near = (a: Point, b: Point, slop: number) => Math.abs(a.x - b.x) <= slop && Math.abs(a.y - b.y) <= slop;
const twoFingers = (event: GestureResponderEvent) => event.nativeEvent.touches.length >= 2;

function scrollSoon(scroll: () => void) {
  scroll();
  requestAnimationFrame(scroll);
}

export function usePinchZoom(zoom: number, setZoom: (zoom: number) => void, enabled: boolean, gutter: number) {
  const [live, setLive] = useState<Live | null>(null);
  const frame = useRef<View>(null);
  const outer = useRef<ScrollView>(null);
  const pan = useRef<ScrollView>(null);
  const origin = useRef<Point>({ x: 0, y: 0 });
  const viewport = useRef({ width: 0, height: 0 });
  const body = useRef({ width: 0, height: 0 });
  const scroll = useRef<Point>({ x: 0, y: 0 });
  const pending = useRef<Partial<Point>>({});
  const pendingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pinch = useRef<Pinch | null>(null);
  const touchStart = useRef<Touch | null>(null);
  const lastTap = useRef<Touch | null>(null);
  const multiTouch = useRef(false);
  const pinchable = enabled && Platform.OS !== "web";

  const measureOrigin = () =>
    frame.current?.measure((_x, _y, _width, _height, pageX, pageY) => {
      origin.current = { x: pageX, y: pageY };
    });

  const anchorAt = (page: Point): Point => ({ x: page.x - origin.current.x - gutter, y: page.y - origin.current.y - gutter });

  const commit = (target: number, anchor: Point | null) => {
    const next = clampZoom(target);
    setLive(null);
    if (next === zoom) return;
    const ratio = next / zoom;
    pending.current = anchor
      ? { x: focalOffset(scroll.current.x, anchor.x, ratio), y: focalOffset(scroll.current.y, anchor.y, ratio) }
      : { x: 0 };
    if (pendingTimer.current) clearTimeout(pendingTimer.current);
    pendingTimer.current = setTimeout(() => {
      pending.current = {};
    }, PENDING_SCROLL_MS);
    setZoom(next);
  };

  const endPinch = () => {
    const current = pinch.current;
    pinch.current = null;
    if (current) commit(zoom * current.scale, current.anchor);
  };

  const frameProps = {
    ref: frame,
    style: { flex: 1 },
    onLayout: (event: LayoutChangeEvent) => {
      viewport.current.height = event.nativeEvent.layout.height;
      measureOrigin();
    },
    onTouchStart: (event: GestureResponderEvent) => {
      measureOrigin();
      const { touches, pageX, pageY } = event.nativeEvent;
      if (touches.length > 1) multiTouch.current = true;
      else if (!multiTouch.current) touchStart.current = { at: Date.now(), point: { x: pageX, y: pageY } };
    },
    onTouchEnd: (event: GestureResponderEvent) => {
      if (event.nativeEvent.touches.length > 0) return;
      const start = touchStart.current;
      const wasMulti = multiTouch.current;
      touchStart.current = null;
      multiTouch.current = false;
      if (!pinchable || wasMulti || !start) return;
      const tap = { at: Date.now(), point: { x: event.nativeEvent.pageX, y: event.nativeEvent.pageY } };
      if (tap.at - start.at > TAP_MS || !near(tap.point, start.point, TAP_SLOP_DP)) {
        lastTap.current = null;
        return;
      }
      const previous = lastTap.current;
      if (previous && tap.at - previous.at <= DOUBLE_TAP_MS && near(tap.point, previous.point, DOUBLE_TAP_SLOP_DP)) {
        lastTap.current = null;
        commit(tapZoom(zoom), anchorAt(tap.point));
      } else {
        lastTap.current = tap;
      }
    },
    onStartShouldSetResponderCapture: (event: GestureResponderEvent) => pinchable && twoFingers(event),
    onMoveShouldSetResponderCapture: (event: GestureResponderEvent) => pinchable && twoFingers(event),
    onResponderGrant: (event: GestureResponderEvent) => {
      const [a, b] = event.nativeEvent.touches;
      if (!a || !b) return true;
      const anchor = anchorAt(midpoint(a, b));
      pinch.current = {
        distance: distance(a, b),
        anchor,
        focal: { x: scroll.current.x + anchor.x, y: scroll.current.y + anchor.y },
        scale: 1,
      };
      return true;
    },
    onResponderMove: (event: GestureResponderEvent) => {
      const [a, b] = event.nativeEvent.touches;
      const current = pinch.current;
      if (!a || !b || !current) return;
      const scale = pinchScale(current.distance, distance(a, b), zoom);
      current.scale = scale;
      setLive({
        scale,
        shift: {
          x: scaleShift(current.focal.x, body.current.width / 2, scale),
          y: scaleShift(current.focal.y, body.current.height / 2, scale),
        },
      });
    },
    onResponderRelease: endPinch,
    onResponderTerminate: endPinch,
    onResponderTerminationRequest: () => pinch.current === null,
  };

  const outerProps = {
    ref: outer,
    scrollEnabled: live === null,
    scrollEventThrottle: 16,
    onScroll: (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      scroll.current.y = event.nativeEvent.contentOffset.y;
    },
    onContentSizeChange: (_width: number, height: number) => {
      const y = pending.current.y;
      if (y === undefined) return;
      pending.current.y = undefined;
      scrollSoon(() => outer.current?.scrollTo({ y: clampOffset(y, height, viewport.current.height), animated: false }));
    },
  };

  const panProps = {
    ref: pan,
    scrollEnabled: zoom > 1 && live === null,
    scrollEventThrottle: 16,
    onLayout: (event: LayoutChangeEvent) => {
      viewport.current.width = event.nativeEvent.layout.width;
    },
    onScroll: (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      scroll.current.x = event.nativeEvent.contentOffset.x;
    },
    onContentSizeChange: (width: number) => {
      const x = pending.current.x;
      if (x === undefined) return;
      pending.current.x = undefined;
      scrollSoon(() => pan.current?.scrollTo({ x: clampOffset(x, width, viewport.current.width), animated: false }));
    },
  };

  const bodyProps = {
    onLayout: (event: LayoutChangeEvent) => {
      body.current = { width: event.nativeEvent.layout.width, height: event.nativeEvent.layout.height };
    },
    style: live
      ? { transform: [{ translateX: live.shift.x }, { translateY: live.shift.y }, { scale: live.scale }] }
      : undefined,
  };

  return { zoomTo: (next: number) => commit(next, null), frameProps, outerProps, panProps, bodyProps };
}
