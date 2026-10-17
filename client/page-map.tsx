import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useEffect, useReducer, useRef, useState } from "react";
import { ActivityIndicator, Image, type LayoutChangeEvent, PixelRatio, Pressable, ScrollView, Text, View } from "react-native";
import { docThumbnailRpc } from "../shared/rpc";
import { createThumbnailLoader, gridLayout, thumbnailCache, type ThumbnailLoader, type ThumbnailState, thumbnailWidth, visibleOrder } from "./thumbnails";
import { type Styles, ToolbarButton } from "./ui";

const MAX_THUMBNAIL_PIXEL_RATIO = 2;

export interface PageMapProps {
  workspaceId: string;
  path: string;
  password?: string;
  revision: string;
  count: number;
  active: number;
  compact: boolean;
  theme: PluginTheme;
  styles: Styles;
  onOpen(index: number): void;
  onClose(): void;
}

export function PageMap({ workspaceId, path, password, revision, count, active, compact, theme, styles, onOpen, onClose }: PageMapProps) {
  const fetchThumbnail = useRpc(docThumbnailRpc);
  const [frame, setFrame] = useState({ width: 0, height: 0 });
  const [offset, setOffset] = useState(0);
  const [measuredTop, setGridTop] = useState<number | null>(null);
  const gridTop = measuredTop ?? styles.gutter;
  const [loader, setLoader] = useState<ThumbnailLoader | null>(null);
  const [, refresh] = useReducer((tick: number) => tick + 1, 0);
  const scroller = useRef<ScrollView>(null);
  const scrolledToActive = useRef(false);
  const layout = frame.width > 0 ? gridLayout(frame.width - styles.gutter * 2, compact) : null;
  const width = layout ? thumbnailWidth(layout.cellWidth, Math.min(MAX_THUMBNAIL_PIXEL_RATIO, PixelRatio.get())) : null;

  useEffect(() => {
    if (width === null) return;
    const next = createThumbnailLoader({
      key: `${workspaceId}\0${path}\0${width}`,
      revision,
      cache: thumbnailCache,
      fetch: (index) => fetchThumbnail({ workspaceId, path, password, index, width }),
    });
    const stop = next.subscribe(refresh);
    setLoader(next);
    return () => {
      stop();
      next.close();
    };
  }, [workspaceId, path, password, revision, width, fetchThumbnail]);

  const columns = layout?.columns ?? 1;
  const rowHeight = layout?.rowHeight ?? 1;
  useEffect(() => {
    if (!loader || frame.height === 0) return;
    loader.want(visibleOrder({ columns, rowHeight, offset: offset - gridTop, viewport: frame.height, count }));
  }, [loader, columns, rowHeight, offset, gridTop, frame.height, count]);

  useEffect(() => {
    if (!layout || measuredTop === null || scrolledToActive.current) return;
    scrolledToActive.current = true;
    const y = gridTop + Math.floor(active / layout.columns) * layout.rowHeight;
    if (y > frame.height / 2) scroller.current?.scrollTo({ y: y - styles.gutter, animated: false });
  }, [layout, measuredTop, gridTop, active, frame.height, styles.gutter]);

  const onLayout = (event: LayoutChangeEvent) => {
    const { width: frameWidth, height } = event.nativeEvent.layout;
    setFrame((current) => (current.width === frameWidth && current.height === height ? current : { width: frameWidth, height }));
  };
  const rows = layout ? Math.ceil(count / layout.columns) : 0;
  const shownRows = layout
    ? {
        first: Math.max(0, Math.floor((offset - gridTop) / layout.rowHeight) - 1),
        last: Math.min(rows - 1, Math.ceil((offset - gridTop + frame.height) / layout.rowHeight)),
      }
    : null;
  const cells: number[] = [];
  if (layout && shownRows) {
    for (let index = shownRows.first * layout.columns; index < Math.min(count, (shownRows.last + 1) * layout.columns); index++) cells.push(index);
  }

  return (
    <View style={styles.screen}>
      <View style={styles.toolbar}>
        <ToolbarButton theme={theme} styles={styles} icon="X" accessibilityLabel="Close page map" onPress={onClose} />
        <Text style={[styles.text, { flex: 1 }]} numberOfLines={1}>Pages</Text>
        <Text style={styles.label}>{count} {count === 1 ? "page" : "pages"}</Text>
      </View>
      <ScrollView
        ref={scroller}
        style={{ flex: 1 }}
        onLayout={onLayout}
        onScroll={(event: { nativeEvent: { contentOffset: { y: number } } }) => setOffset(event.nativeEvent.contentOffset.y)}
        scrollEventThrottle={64}
        contentContainerStyle={{ padding: styles.gutter, paddingBottom: styles.gutter + styles.bottomInset }}
      >
        <View onLayout={(event: LayoutChangeEvent) => setGridTop(styles.gutter + event.nativeEvent.layout.height)} />
        {layout ? (
          <View style={{ position: "relative", height: rows * layout.rowHeight }} accessibilityLabel="Page thumbnails">
            {cells.map((index) => (
              <ThumbnailCell
                key={index}
                index={index}
                state={loader?.state(index)}
                current={index === active}
                left={(index % layout.columns) * (layout.cellWidth + layout.gap)}
                top={Math.floor(index / layout.columns) * layout.rowHeight}
                width={layout.cellWidth}
                height={layout.imageHeight}
                theme={theme}
                styles={styles}
                onOpen={() => onOpen(index)}
                onRetry={() => loader?.retry(index)}
              />
            ))}
          </View>
        ) : null}
      </ScrollView>
    </View>
  );
}

function ThumbnailCell({ index, state, current, left, top, width, height, theme, styles, onOpen, onRetry }: {
  index: number;
  state: ThumbnailState | undefined;
  current: boolean;
  left: number;
  top: number;
  width: number;
  height: number;
  theme: PluginTheme;
  styles: Styles;
  onOpen(): void;
  onRetry(): void;
}) {
  const label = `Page ${index + 1}`;
  let body;
  if (state?.status === "ready") {
    const scale = Math.min((width - 2) / state.image.width, (height - 2) / state.image.height);
    body = (
      <Image
        source={{ uri: `data:${state.image.mimeType};base64,${state.image.data}` }}
        style={{ width: Math.round(state.image.width * scale), height: Math.round(state.image.height * scale) }}
        resizeMode="contain"
        accessibilityLabel={`${label} thumbnail`}
      />
    );
  } else if (state?.status === "failed" || state?.status === "stale") {
    body = <Icon name="ImageOff" size={18} color={theme.colors.foregroundMuted} />;
  } else {
    body = <ActivityIndicator size="small" color={theme.colors.foregroundMuted} />;
  }
  return (
    <View style={{ position: "absolute", left, top, width }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Open page ${index + 1}`}
        accessibilityState={{ selected: current }}
        onPress={onOpen}
        style={{
          width,
          height,
          alignItems: "center",
          justifyContent: "center",
          borderRadius: 4,
          borderWidth: current ? 2 : 1,
          borderColor: current ? theme.colors.accent : theme.colors.border,
          backgroundColor: theme.colors.surface1,
          overflow: "hidden",
        }}
      >
        {body}
      </Pressable>
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 4, height: 22 }}>
        <Text style={[styles.label, current ? { color: theme.colors.foreground } : null]}>{index + 1}</Text>
        {state?.status === "failed" ? (
          <Pressable accessibilityRole="button" accessibilityLabel={`Retry thumbnail for page ${index + 1}`} onPress={onRetry} hitSlop={6}>
            <Icon name="RotateCcw" size={12} color={theme.colors.foregroundMuted} />
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}
