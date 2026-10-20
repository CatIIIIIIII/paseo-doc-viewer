import type { PluginTheme } from "@getpaseo/plugin";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { Pressable, Text, View } from "react-native";
import { absoluteTime, baseName, humanSize, KIND_ICON, parentDir } from "./format";
import { kindColor, type KindPalette } from "./kind-colors";
import type { DetailsColumns } from "./panel-layout";
import { entryLabel, type RecentEntry } from "./recent";
import { StatusPill, type Styles } from "./ui";

interface DetailsProps {
  theme: PluginTheme;
  styles: Styles;
  columns: DetailsColumns;
}

const ROW_PADDING = 8;
const ICON_GAP = 8;
const FOLDER_FLEX = 0.8;

export function DetailsHeader({ theme, styles, columns }: DetailsProps) {
  const title = { color: theme.colors.foregroundMuted, fontSize: 11, fontWeight: "600" as const, letterSpacing: 0.5 };
  return (
    <View
      accessible={false}
      importantForAccessibility="no-hide-descendants"
      style={{ flexDirection: "row", alignItems: "center", gap: ICON_GAP, paddingHorizontal: 8 + ROW_PADDING, paddingTop: 8, paddingBottom: 2 }}
    >
      <View style={{ width: columns.iconSize }} />
      <Text style={[title, { flex: 1 }]}>NAME</Text>
      {columns.folder === "column" ? <Text style={[title, { flex: FOLDER_FLEX }]}>FOLDER</Text> : null}
      {columns.size ? <Text style={[title, { width: 64, textAlign: "right" }]}>SIZE</Text> : null}
      <Text style={[title, { width: columns.timeWidth, paddingLeft: 12 }]}>MODIFIED</Text>
      <Text style={[title, { width: columns.statusWidth }]}>STATUS</Text>
    </View>
  );
}

export function DetailsRow({
  theme,
  styles,
  columns,
  entry,
  palette,
  now,
  onPress,
}: DetailsProps & { entry: RecentEntry; palette: KindPalette; now: number; onPress(): void }) {
  const folder = parentDir(entry.path);
  const cell = [styles.label, { fontSize: 12 }];
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={entryLabel(entry, now, [humanSize(entry.size)])}
      onPress={onPress}
      style={({ pressed, hovered }: { pressed: boolean; hovered?: boolean }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: ICON_GAP,
        minHeight: columns.rowHeight,
        paddingHorizontal: ROW_PADDING,
        borderRadius: 6,
        backgroundColor: pressed || hovered ? theme.colors.surface2 : "transparent",
      })}
    >
      <Icon name={KIND_ICON[entry.kind]} size={columns.iconSize} color={kindColor(palette, entry.kind)} />
      <View style={{ flex: 1, minWidth: 0, flexDirection: "row", alignItems: "baseline", gap: 6 }}>
        <Text style={[styles.text, { fontSize: columns.nameSize, flexShrink: 1 }]} numberOfLines={1}>
          {baseName(entry.path)}
        </Text>
        {columns.folder === "inline" && folder ? (
          <Text style={[styles.muted, { flexShrink: 3 }]} numberOfLines={1}>
            {folder}
          </Text>
        ) : null}
      </View>
      {columns.folder === "column" ? (
        <Text style={[styles.muted, { flex: FOLDER_FLEX, minWidth: 0 }]} numberOfLines={1}>
          {folder}
        </Text>
      ) : null}
      {columns.size ? <Text style={[cell, { width: 64, textAlign: "right" }]} numberOfLines={1}>{humanSize(entry.size)}</Text> : null}
      <Text style={[cell, { width: columns.timeWidth, paddingLeft: 12 }]} numberOfLines={1}>
        {absoluteTime(entry.mtimeMs, now, columns.time)}
      </Text>
      <View style={{ width: columns.statusWidth, flexDirection: "row" }}>
        {entry.review || entry.isNew ? <StatusPill theme={theme} styles={styles} status={entry.review ?? "new"} label="short" /> : null}
      </View>
    </Pressable>
  );
}
