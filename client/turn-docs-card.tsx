import type { PluginClientContext, PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import { Image, Pressable, Text, View } from "react-native";
import { viewerStateOpenedRevisionsRpc } from "../shared/rpc";
import type { TurnDocs, TurnDocsFile } from "../shared/turn-docs";
import { createCardThumbnails } from "./card-thumbnails";
import { TURN_CARDS_SETTING_HINT, TURN_FILE_PILL, TURN_THUMBNAIL_SIZE, turnDocsNote, turnDocsTitle, turnFilePill, type TurnFilePill } from "./turn-docs";
import { baseName, humanSize, KIND_ICON, KIND_LABEL, parentDir } from "./format";
import { openedMarks } from "./opened-marks";
import { DOCUMENTS_PANEL_ID, documentScreen, SETTINGS_SCREEN_ID } from "./recent";
import type { ThumbnailLoader, ThumbnailState } from "./thumbnails";
import { makeStyles, StatusPill, ToolbarButton, type Styles } from "./ui";

type CardClient = Pick<PluginClientContext, "openScreen" | "openPanel" | "openSettings" | "rpc">;
type Theme = PluginTimelineItemProps["theme"];

// Closes over the client: timeline item props carry no navigation or RPC provider in this SDK.
export function createTurnDocsCard(client: CardClient) {
  return function TurnDocsCard({ item, theme, layout }: PluginTimelineItemProps<TurnDocs>) {
    const data = item.data;
    const styles = useMemo(() => makeStyles(theme, layout.compact), [theme, layout.compact]);
    const size = layout.compact ? TURN_THUMBNAIL_SIZE.compact : TURN_THUMBNAIL_SIZE.wide;
    const thumbnails = useCardThumbnails(client, data);
    const opened = useOpenedRevisions(client, data);
    const siblings = data.files.map((file) => file.path);
    const [settingsFailed, setSettingsFailed] = useState(false);
    const note = turnDocsNote(data);
    // The host throws when it cannot open the screen; an exception in a press handler is fatal on native.
    const openSettings = () => {
      try {
        client.openSettings(SETTINGS_SCREEN_ID);
      } catch {
        setSettingsFailed(true);
      }
    };
    return (
      <View style={[styles.card, { paddingVertical: 8, paddingHorizontal: layout.compact ? 8 : 10, gap: 2, marginVertical: 4 }]}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 4, paddingBottom: 4 }}>
          <Icon name="Files" size={14} color={theme.colors.foregroundMuted} />
          <Text style={[styles.muted, { flex: 1, fontSize: 13 }]} numberOfLines={2}>
            {turnDocsTitle(data)}
          </Text>
          <SettingsLink theme={theme} styles={styles} onPress={openSettings} />
        </View>
        {data.files.map((file, index) => (
          <FileRow
            key={file.path}
            file={file}
            thumbnail={thumbnails?.state(index)}
            pill={turnFilePill(file, opened[file.path])}
            size={size}
            styles={styles}
            theme={theme}
            onOpen={() => client.openScreen(documentScreen(data.workspaceId, file.path, siblings))}
          />
        ))}
        {data.moreCount > 0 ? (
          <View style={{ flexDirection: "row", paddingHorizontal: 4, paddingTop: 4 }}>
            <ToolbarButton
              theme={theme}
              styles={styles}
              icon="FileText"
              label={`+${data.moreCount} more in Documents`}
              onPress={() => client.openPanel(DOCUMENTS_PANEL_ID, { workspaceId: data.workspaceId })}
            />
          </View>
        ) : null}
        {note ? <Text style={[styles.muted, { paddingHorizontal: 4, paddingTop: 4 }]}>{note}</Text> : null}
        {settingsFailed ? <Text style={[styles.muted, { paddingHorizontal: 4, paddingTop: 4 }]}>{TURN_CARDS_SETTING_HINT}</Text> : null}
      </View>
    );
  };
}

// Quiet on purpose: the card shows after every turn that changed documents. The visual box stays
// about one text line tall so the header keeps its height; the hit slop makes a 44 pt target on phones.
function SettingsLink({ theme, styles, onPress }: { theme: Theme; styles: Styles; onPress(): void }) {
  const color = theme.colors.foregroundMuted;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Settings: show changed documents after each turn"
      accessibilityHint="Opens Settings, Document viewer, where these cards can be turned off"
      hitSlop={styles.compact ? 11 : 4}
      onPress={onPress}
      style={({ pressed, hovered }: { pressed: boolean; hovered?: boolean }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: 4,
        height: 22,
        minWidth: 22,
        paddingHorizontal: 4,
        borderRadius: 6,
        justifyContent: "center",
        backgroundColor: pressed || hovered ? theme.colors.surface2 : "transparent",
      })}
    >
      <Icon name="Settings" size={14} color={color} />
      {styles.compact ? null : <Text style={{ color, fontSize: 12 }}>Settings</Text>}
    </Pressable>
  );
}

function useCardThumbnails(client: CardClient, data: TurnDocs): ThumbnailLoader | null {
  const [loader, setLoader] = useState<ThumbnailLoader | null>(null);
  const [, refresh] = useReducer((tick: number) => tick + 1, 0);
  const identity = data.files.map((file) => `${file.path}\0${file.revision}`).join("\0");
  useEffect(() => {
    const next = createCardThumbnails(client, data);
    const stop = next.subscribe(refresh);
    setLoader(next);
    return () => {
      stop();
      next.close();
    };
    // `identity` stands for `files`, which the host may hand over as a new array on every render.
  }, [data.workspaceId, identity]);
  return loader;
}

function useOpenedRevisions(client: CardClient, data: TurnDocs): Readonly<Record<string, string>> {
  const [opened, setOpened] = useState<Readonly<Record<string, string>>>({});
  const latest = useRef(0);
  const paths = data.files.map((file) => file.path);
  const identity = paths.join("\0");
  useEffect(() => {
    if (paths.length === 0) return;
    const read = () => {
      const request = ++latest.current;
      client.rpc(viewerStateOpenedRevisionsRpc, { workspaceId: data.workspaceId, paths }).then(
        (answer) => { if (request === latest.current) setOpened(answer.opened); },
        () => {},
      );
    };
    read();
    const stop = openedMarks.subscribe((event) => {
      if (event.workspaceId === data.workspaceId && paths.includes(event.path)) read();
    });
    return () => {
      latest.current++;
      stop();
    };
  }, [data.workspaceId, identity]);
  return opened;
}

function FileThumbnail({ file, state, size, theme }: { file: TurnDocsFile; state: ThumbnailState | undefined; size: number; theme: Theme }) {
  const image = state?.status === "ready" ? state.image : null;
  return (
    <View style={{ width: size, height: size, borderRadius: 4, overflow: "hidden", alignItems: "center", justifyContent: "center",
      backgroundColor: image ? theme.colors.surface2 : "transparent" }}>
      {image ? (
        <Image source={{ uri: `data:${image.mimeType};base64,${image.data}` }} style={{ width: size, height: size }} resizeMode="contain"
          accessible={false} />
      ) : (
        <Icon name={KIND_ICON[file.kind]} size={16} color={theme.colors.foregroundMuted} />
      )}
    </View>
  );
}

function FileRow({ file, thumbnail, pill, size, styles, theme, onOpen }: {
  file: TurnDocsFile; thumbnail: ThumbnailState | undefined; pill: TurnFilePill; size: number; styles: Styles; theme: Theme; onOpen(): void;
}) {
  const folder = parentDir(file.path);
  const { status, spoken } = TURN_FILE_PILL[pill];
  return (
    <View
      accessible={false}
      style={{ flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 4, paddingVertical: styles.compact ? 4 : 3 }}
    >
      <FileThumbnail file={file} state={thumbnail} size={size} theme={theme} />
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6, minWidth: 0 }}>
          <Text style={[styles.text, { flexShrink: 1 }]} numberOfLines={1}>
            {baseName(file.path)}
          </Text>
          <StatusPill theme={theme} styles={styles} status={status} label="short" />
        </View>
        <Text style={styles.muted} numberOfLines={1}>
          {folder ? `${folder} · ` : ""}
          {humanSize(file.size)}
        </Text>
      </View>
      <ToolbarButton
        theme={theme}
        styles={styles}
        label="Open"
        accessibilityLabel={`Open ${file.path}, ${KIND_LABEL[file.kind]}, ${spoken}`}
        onPress={onOpen}
      />
    </View>
  );
}
