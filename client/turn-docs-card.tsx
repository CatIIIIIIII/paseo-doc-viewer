import type { PluginClientContext, PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { TurnDocs, TurnDocsFile } from "../shared/turn-docs";
import { TURN_CARDS_SETTING_HINT, turnDocsNote, turnDocsTitle } from "./turn-docs";
import { baseName, humanSize, KIND_ICON, KIND_LABEL, parentDir } from "./format";
import { DOCUMENTS_PANEL_ID, documentScreen, SETTINGS_SCREEN_ID } from "./recent";
import { makeStyles, StatusPill, ToolbarButton, type Styles } from "./ui";

type Navigation = Pick<PluginClientContext, "openScreen" | "openPanel" | "openSettings">;
type Theme = PluginTimelineItemProps["theme"];

// Closes over the client: timeline item props carry no navigation in this SDK.
export function createTurnDocsCard(client: Navigation) {
  return function TurnDocsCard({ item, theme, layout }: PluginTimelineItemProps<TurnDocs>) {
    const data = item.data;
    const styles = useMemo(() => makeStyles(theme, layout.compact), [theme, layout.compact]);
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
        {data.files.map((file) => (
          <FileRow
            key={file.path}
            file={file}
            styles={styles}
            theme={theme}
            onOpen={() => client.openScreen(documentScreen(data.workspaceId, file.path))}
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

function FileRow({ file, styles, theme, onOpen }: { file: TurnDocsFile; styles: Styles; theme: Theme; onOpen(): void }) {
  const folder = parentDir(file.path);
  const status = file.status === "new" ? "new" : "changed during this turn";
  return (
    <View
      accessible={false}
      style={{ flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 4, paddingVertical: styles.compact ? 4 : 3 }}
    >
      <Icon name={KIND_ICON[file.kind]} size={16} color={theme.colors.foregroundMuted} />
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6, minWidth: 0 }}>
          <Text style={[styles.text, { flexShrink: 1 }]} numberOfLines={1}>
            {baseName(file.path)}
          </Text>
          <StatusPill theme={theme} styles={styles} status={file.status === "new" ? "new" : "modified"} label="short" />
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
        accessibilityLabel={`Open ${file.path}, ${KIND_LABEL[file.kind]}, ${status}`}
        onPress={onOpen}
      />
    </View>
  );
}
