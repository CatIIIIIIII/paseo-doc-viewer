import type { PluginTheme } from "@getpaseo/plugin";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { memo, type ReactNode, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { Image, Pressable, Text, View } from "react-native";
import { extensionOf } from "../shared/kinds";
import type { DocThumbnailInput, DocThumbnailOutput } from "../shared/rpc";
import { baseName, KIND_ICON } from "./format";
import { kindColor, type KindPalette } from "./kind-colors";
import { PREVIEW_CAPTION_HEIGHT, type PreviewGrid } from "./panel-layout";
import { createPreviewLoader, type HeldRevision, holdRevisions, nextRelease, type PreviewLoader, type PreviewTarget, wantsPreview } from "./previews";
import type { RecentEntry } from "./recent";
import { type Thumbnail, thumbnailCache } from "./thumbnails";
import { StatusPill, type Styles } from "./ui";

export interface Preview {
  thumbnail: Thumbnail | null;
  loading: boolean;
}

export const countText = (kind: RecentEntry["kind"], count: number) => {
  const noun = kind === "pptx" ? "slide" : "page";
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
};

function TitleCard({ theme, title, size }: { theme: PluginTheme; title: string; size: number }) {
  const width = size - 16;
  return (
    <View style={{ width, height: Math.round((width * 9) / 16), padding: 8, borderRadius: 3, borderWidth: 1, borderColor: theme.colors.border, backgroundColor: theme.colors.surface0, justifyContent: "center" }}>
      <Text style={{ color: theme.colors.foreground, fontSize: 12, fontWeight: "600", textAlign: "center" }} numberOfLines={3}>
        {title}
      </Text>
    </View>
  );
}

export function usePreviews(
  workspaceId: string,
  entries: readonly RecentEntry[],
  grid: PreviewGrid | null,
  visible: ReadonlySet<string> | null,
  fetchThumbnail: (input: DocThumbnailInput) => Promise<DocThumbnailOutput>,
): (entry: RecentEntry) => Preview {
  const [tick, bump] = useReducer((value: number) => value + 1, 0);
  const [, repaint] = useReducer((value: number) => value + 1, 0);
  const heldRef = useRef(new Map<string, HeldRevision>());
  const held = useMemo(() => (heldRef.current = holdRevisions(heldRef.current, entries, Date.now())), [entries, tick]);
  useEffect(() => {
    const wait = nextRelease(held, Date.now());
    if (wait === null) return;
    const timer = setTimeout(bump, wait + 50);
    return () => clearTimeout(timer);
  }, [held]);

  const targets = useMemo(
    () => new Map(entries.filter(wantsPreview).map((entry): [string, PreviewTarget] => [entry.path, { path: entry.path, revision: held.get(entry.path)?.held ?? entry.revision }])),
    [entries, held],
  );
  const width = grid?.requestWidth ?? null;
  const fetchRef = useRef(fetchThumbnail);
  fetchRef.current = fetchThumbnail;
  const key = `${workspaceId}\0${width}`;
  const [built, setBuilt] = useState<{ key: string; loader: PreviewLoader } | null>(null);
  useEffect(() => {
    if (width === null) return setBuilt(null);
    const loader = createPreviewLoader({ workspaceId, width, fetch: (input) => fetchRef.current(input) });
    const stop = loader.subscribe(repaint);
    setBuilt({ key, loader });
    return () => {
      stop();
      loader.close();
    };
  }, [key]);
  const loader = built?.key === key ? built.loader : null;
  const visibleKey = visible ? [...visible].join("\0") : null;
  useEffect(() => {
    loader?.show([...targets.values()], visible);
  }, [loader, targets, visibleKey]);

  // The last picture drawn for each path, as its key in the bounded thumbnail cache, so a rewritten file
  // keeps it until the new one arrives. Paths no longer listed are dropped.
  const shown = useRef(new Map<string, string>());
  useEffect(() => {
    for (const path of shown.current.keys()) if (!targets.has(path)) shown.current.delete(path);
  }, [targets]);
  return (entry) => {
    const target = targets.get(entry.path);
    const state = target && loader ? loader.state(target) : undefined;
    if (target && loader && state?.status === "ready") {
      shown.current.set(entry.path, loader.cacheKey(target));
      return { thumbnail: state.thumbnail, loading: false };
    }
    const last = shown.current.get(entry.path);
    const thumbnail = last === undefined ? null : thumbnailCache.get(last) ?? null;
    return { thumbnail, loading: target !== undefined && loader !== null && (state === undefined || state.status === "loading") };
  };
}

interface TileProps {
  theme: PluginTheme;
  styles: Styles;
  palette: KindPalette;
  entry: RecentEntry;
  thumbnail: Thumbnail | null;
  loading: boolean;
  size: number;
  label: string;
  when: string;
  onOpen(path: string): void;
}

export const PreviewTile = memo(function PreviewTile({ theme, styles, palette, entry, thumbnail, loading, size, label, when, onOpen }: TileProps) {
  const color = kindColor(palette, entry.kind);
  const count = thumbnail?.count;
  const picture = thumbnail && (thumbnail.type === "image" || thumbnail.title !== "") ? thumbnail : null;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={() => onOpen(entry.path)}
      style={({ pressed, hovered }: { pressed: boolean; hovered?: boolean }) => ({
        width: size,
        borderRadius: 8,
        opacity: pressed ? 0.8 : 1,
        backgroundColor: hovered ? theme.colors.surface1 : "transparent",
      })}
    >
      <View
        style={{
          width: size,
          height: size,
          borderRadius: 6,
          borderWidth: 1,
          borderColor: theme.colors.border,
          overflow: "hidden",
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: picture ? theme.colors.surface2 : theme.colors.surface1,
        }}
      >
        {picture ? (
          <>
            {picture.type === "image" ? (
              <Image
                source={{ uri: `data:${picture.image.mimeType};base64,${picture.image.data}` }}
                style={{ width: size - 2, height: size - 2 }}
                resizeMode="contain"
                accessible={false}
                importantForAccessibility="no"
              />
            ) : (
              <TitleCard theme={theme} title={picture.title} size={size} />
            )}
            <View style={{ position: "absolute", left: 6, bottom: 6, width: 20, height: 20, borderRadius: 10, alignItems: "center", justifyContent: "center", backgroundColor: theme.colors.surface0 }}>
              <Icon name={KIND_ICON[entry.kind]} size={12} color={color} />
            </View>
          </>
        ) : (
          <View style={{ alignItems: "center", gap: 6, opacity: loading ? 0.6 : 1 }}>
            <Icon name={KIND_ICON[entry.kind]} size={32} color={color} />
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11, fontWeight: "600" }}>{extensionOf(entry.path).toUpperCase()}</Text>
          </View>
        )}
      </View>
      <View style={{ height: PREVIEW_CAPTION_HEIGHT, justifyContent: "center", gap: 2, paddingHorizontal: 2 }}>
        <Text style={[styles.text, { fontSize: 13 }]} numberOfLines={1}>
          {baseName(entry.path)}
        </Text>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 4, minWidth: 0 }}>
          {entry.review || entry.isNew ? <StatusPill theme={theme} styles={styles} status={entry.review ?? "new"} label="none" /> : null}
          <Text style={[styles.muted, { flexShrink: 1 }]} numberOfLines={1}>
            {count === undefined ? when : `${when} · ${countText(entry.kind, count)}`}
          </Text>
        </View>
      </View>
    </Pressable>
  );
});

export function TileRow({ grid, children }: { grid: PreviewGrid; children: ReactNode }) {
  return <View style={{ flexDirection: "row", gap: grid.gap, paddingVertical: grid.gap / 2 }}>{children}</View>;
}
