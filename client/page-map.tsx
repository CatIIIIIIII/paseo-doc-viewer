import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { Icon, TextInput } from "@getpaseo/plugin/client/react-native";
import { useEffect, useReducer, useRef, useState } from "react";
import { ActivityIndicator, Image, type LayoutChangeEvent, PixelRatio, Pressable, ScrollView, Text, View } from "react-native";
import { PIN_LABEL_MAX_CHARS } from "../shared/limits";
import { docThumbnailRpc } from "../shared/rpc";
import type { PagePin } from "../shared/viewer-state";
import { pinStatus } from "./pins";
import { createThumbnailLoader, gridLayout, pageThumbnailKey, thumbnailAnswer, thumbnailCache, type ThumbnailLoader, type ThumbnailState, thumbnailWidth, visibleOrder } from "./thumbnails";
import { type Styles, ToolbarButton } from "./ui";
import { useViewerMarks } from "./use-viewer-marks";

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
  const gridTop = styles.gutter;
  const [loader, setLoader] = useState<ThumbnailLoader | null>(null);
  const [, refresh] = useReducer((tick: number) => tick + 1, 0);
  const scroller = useRef<ScrollView>(null);
  const pins = useViewerMarks(workspaceId, path);
  const pinned = new Set(pins.pins.map((pin) => pin.index));
  const scrolledToActive = useRef(false);
  const layout = frame.width > 0 ? gridLayout(frame.width - styles.gutter * 2, compact) : null;
  const width = layout ? thumbnailWidth(layout.cellWidth, Math.min(MAX_THUMBNAIL_PIXEL_RATIO, PixelRatio.get())) : null;

  useEffect(() => {
    if (width === null) return;
    const next = createThumbnailLoader({
      identify: (index) => ({ key: pageThumbnailKey(workspaceId, path, width, index, password !== undefined), revision }),
      cache: thumbnailCache,
      fetch: (index) => fetchThumbnail({ workspaceId, path, password, index, width }).then(thumbnailAnswer),
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
    if (!layout || scrolledToActive.current) return;
    scrolledToActive.current = true;
    const y = gridTop + Math.floor(active / layout.columns) * layout.rowHeight;
    if (y > frame.height / 2) scroller.current?.scrollTo({ y: y - styles.gutter, animated: false });
  }, [layout, gridTop, active, frame.height, styles.gutter]);

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
      <PinSection pins={pins} active={active} revision={revision} count={count} compact={compact} theme={theme} styles={styles} onOpen={onOpen} />
      <ScrollView
        ref={scroller}
        style={{ flex: 1 }}
        onLayout={onLayout}
        onScroll={(event: { nativeEvent: { contentOffset: { y: number } } }) => setOffset(event.nativeEvent.contentOffset.y)}
        scrollEventThrottle={64}
        contentContainerStyle={{ padding: styles.gutter, paddingBottom: styles.gutter + styles.bottomInset }}
      >
        {layout ? (
          <View style={{ position: "relative", height: rows * layout.rowHeight }} accessibilityLabel="Page thumbnails">
            {cells.map((index) => (
              <ThumbnailCell
                key={index}
                index={index}
                state={loader?.state(index)}
                current={index === active}
                pinned={pinned.has(index)}
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

function PinSection({ pins, active, revision, count, compact, theme, styles, onOpen }: {
  pins: ReturnType<typeof useViewerMarks>;
  active: number;
  revision: string;
  count: number;
  compact: boolean;
  theme: PluginTheme;
  styles: Styles;
  onOpen(index: number): void;
}) {
  const [label, setLabel] = useState<string | null>(null);
  const activePin = pins.pins.find((pin) => pin.index === active);
  const save = async () => {
    if (label !== null && (await pins.setPin(active, { label, revision }))) setLabel(null);
  };
  return (
    <View style={{ gap: 8, paddingHorizontal: styles.gutter, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: theme.colors.border }}>
      {label === null ? (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <ToolbarButton theme={theme} styles={styles} icon="Bookmark" label={activePin ? `Edit pin on page ${active + 1}` : `Pin page ${active + 1}`}
            disabled={!pins.ready} onPress={() => setLabel(activePin?.label ?? "")} />
          {pins.failed ? <Text style={styles.muted}>Pins are unavailable right now</Text> : null}
        </View>
      ) : (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <TextInput
            value={label}
            onChangeText={setLabel}
            onSubmitEditing={() => void save()}
            placeholder={`Label for page ${active + 1} (optional)`}
            placeholderTextColor={theme.colors.foregroundMuted}
            accessibilityLabel="Pin label"
            maxLength={PIN_LABEL_MAX_CHARS}
            autoFocus
            returnKeyType="done"
            style={{ flex: 1, minWidth: 0, height: styles.inputHeight, paddingHorizontal: 8, borderWidth: 1, borderColor: theme.colors.border, borderRadius: 6,
              backgroundColor: theme.colors.surface1, color: theme.colors.foreground, fontSize: compact ? 16 : 13, outlineWidth: 0 }}
          />
          <ToolbarButton theme={theme} styles={styles} label="Save pin" disabled={pins.saving} onPress={() => void save()} />
          <ToolbarButton theme={theme} styles={styles} label="Cancel" onPress={() => setLabel(null)} />
        </View>
      )}
      {pins.pins.length > 0 ? (
        <ScrollView style={{ flexGrow: 0, maxHeight: compact ? 150 : 200 }} contentContainerStyle={{ gap: 6 }} accessibilityLabel="Pinned pages">
          {pins.pins.map((pin) => (
            <PinRow key={pin.index} pin={pin} revision={revision} count={count} saving={pins.saving} theme={theme} styles={styles}
              onOpen={() => onOpen(pin.index)}
              onConfirm={() => void pins.setPin(pin.index, { label: pin.label, revision })}
              onRemove={() => void pins.setPin(pin.index, null)} />
          ))}
        </ScrollView>
      ) : null}
    </View>
  );
}

const PIN_NOTE = { current: null, changed: "May need checking: the file changed since this pin was saved", missing: "This page no longer exists" } as const;

function PinRow({ pin, revision, count, saving, theme, styles, onOpen, onConfirm, onRemove }: {
  pin: PagePin;
  revision: string;
  count: number;
  saving: boolean;
  theme: PluginTheme;
  styles: Styles;
  onOpen(): void;
  onConfirm(): void;
  onRemove(): void;
}) {
  const status = pinStatus(pin, revision, count);
  const note = PIN_NOTE[status];
  const page = `Page ${pin.index + 1}`;
  return (
    <View style={[styles.card, { flexDirection: "row", alignItems: "center", gap: 8, paddingRight: 8 }]}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Open pin: ${page}${pin.label ? `, ${pin.label}` : ""}${note ? `, ${note}` : ""}`}
        disabled={status === "missing"}
        onPress={onOpen}
        style={{ flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 8, paddingLeft: 10 }}
      >
        <Icon name="Bookmark" size={14} color={status === "current" ? theme.colors.accent : theme.colors.statusWarning} />
        <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
          <Text style={styles.text} numberOfLines={1}>
            {page}{pin.label ? ` · ${pin.label}` : ""}
          </Text>
          {note ? <Text style={[styles.muted, { color: theme.colors.statusWarning }]} numberOfLines={2}>{note}</Text> : null}
        </View>
      </Pressable>
      {status === "changed" ? (
        <ToolbarButton theme={theme} styles={styles} icon="Check" accessibilityLabel={`Confirm pin on ${page.toLowerCase()}`} disabled={saving} onPress={onConfirm} />
      ) : null}
      <ToolbarButton theme={theme} styles={styles} icon="X" accessibilityLabel={`Remove pin on ${page.toLowerCase()}`} disabled={saving} onPress={onRemove} />
    </View>
  );
}

function ThumbnailCell({ index, state, current, pinned, left, top, width, height, theme, styles, onOpen, onRetry }: {
  index: number;
  state: ThumbnailState | undefined;
  current: boolean;
  pinned: boolean;
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
  if (state?.status === "ready" && state.thumbnail.type === "image") {
    const { image } = state.thumbnail;
    const scale = Math.min((width - 2) / image.width, (height - 2) / image.height);
    body = (
      <Image
        source={{ uri: `data:${image.mimeType};base64,${image.data}` }}
        style={{ width: Math.round(image.width * scale), height: Math.round(image.height * scale) }}
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
        accessibilityLabel={`Open page ${index + 1}${pinned ? ", pinned" : ""}`}
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
        {pinned ? (
          <View pointerEvents="none" style={{ position: "absolute", top: 4, right: 4, padding: 3, borderRadius: 4, backgroundColor: theme.colors.accent }}>
            <Icon name="Bookmark" size={12} color={theme.colors.accentForeground} />
          </View>
        ) : null}
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
