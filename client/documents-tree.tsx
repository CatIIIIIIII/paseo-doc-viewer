import type { PluginTheme } from "@getpaseo/plugin";
import { FlatList, Icon } from "@getpaseo/plugin/client/react-native";
import { type ReactElement, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { baseName, humanSize, KIND_ICON, relativeTime } from "./format";
import { ALL_EXPANDED, TOP_EXPANDED, type TreeExpansion, type TreeRow } from "./folder-tree";
import { kindColor, type KindPalette } from "./kind-colors";
import { type TreeLayout, treeIndent } from "./panel-layout";
import { entryLabel, type RecentEntry } from "./recent";
import { StatusPill, type Styles, ToolbarButton } from "./ui";

interface ChromeProps {
  theme: PluginTheme;
  styles: Styles;
  layout: TreeLayout;
}

const ROW_PADDING = 8;

const expansions = new Map<string, TreeExpansion>();

export function useTreeExpansion(scope: string, filterKey: string | null): [TreeExpansion, (next: TreeExpansion) => void] {
  const [saved, setSaved] = useState(() => ({ scope, expansion: expansions.get(scope) ?? TOP_EXPANDED }));
  const [filtered, setFiltered] = useState<{ key: string; expansion: TreeExpansion } | null>(null);
  const current =
    filterKey !== null
      ? filtered?.key === filterKey ? filtered.expansion : ALL_EXPANDED
      : saved.scope === scope ? saved.expansion : expansions.get(scope) ?? TOP_EXPANDED;
  const set = (next: TreeExpansion) => {
    if (filterKey !== null) {
      setFiltered({ key: filterKey, expansion: next });
      return;
    }
    expansions.set(scope, next);
    setSaved({ scope, expansion: next });
  };
  return [current, set];
}

export function TreeActions({
  theme,
  styles,
  layout,
  notice,
  onExpandAll,
  onCollapseAll,
}: ChromeProps & { notice: string | null; onExpandAll(): void; onCollapseAll(): void }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 8 + ROW_PADDING, paddingTop: 8 }}>
      <Text style={[styles.muted, { flex: 1 }]} numberOfLines={2}>
        {notice ?? ""}
      </Text>
      <ToolbarButton
        theme={theme}
        styles={styles}
        icon="ChevronsUpDown"
        label={layout.actionLabels ? "Expand all" : undefined}
        accessibilityLabel="Expand all folders"
        onPress={onExpandAll}
      />
      <ToolbarButton
        theme={theme}
        styles={styles}
        icon="ChevronsDownUp"
        label={layout.actionLabels ? "Collapse all" : undefined}
        accessibilityLabel="Collapse all folders"
        onPress={onCollapseAll}
      />
    </View>
  );
}

const rowKey = (row: TreeRow<RecentEntry>) => (row.type === "folder" ? `folder:${row.path}` : `file:${row.entry.path}`);

export function TreeList({
  theme,
  styles,
  layout,
  rows,
  palette,
  now,
  footer,
  onToggle,
  onOpen,
}: ChromeProps & {
  rows: readonly TreeRow<RecentEntry>[];
  palette: KindPalette;
  now: number;
  footer: ReactElement | null;
  onToggle(chain: readonly string[], open: boolean): void;
  onOpen(path: string): void;
}) {
  return (
    <FlatList
      data={rows}
      keyExtractor={rowKey}
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={{ padding: 8, paddingBottom: 8 + styles.bottomInset }}
      renderItem={({ item }: { item: TreeRow<RecentEntry> }) =>
        item.type === "folder" ? (
          <FolderRow theme={theme} styles={styles} layout={layout} row={item} onPress={() => onToggle(item.chain, !item.expanded)} />
        ) : (
          <FileRow theme={theme} styles={styles} layout={layout} row={item} palette={palette} now={now} onPress={() => onOpen(item.entry.path)} />
        )
      }
      ListFooterComponent={footer}
    />
  );
}

const rowStyle = (theme: PluginTheme, layout: TreeLayout, depth: number) =>
  ({ pressed, hovered }: { pressed: boolean; hovered?: boolean }) => ({
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: 8,
    minHeight: layout.rowHeight,
    paddingLeft: ROW_PADDING + treeIndent(layout, depth),
    paddingRight: ROW_PADDING,
    borderRadius: 6,
    backgroundColor: pressed || hovered ? theme.colors.surface2 : "transparent",
  });

function FolderRow({ theme, styles, layout, row, onPress }: ChromeProps & { row: Extract<TreeRow<RecentEntry>, { type: "folder" }>; onPress(): void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${row.name}, folder, ${row.count} ${row.count === 1 ? "document" : "documents"}`}
      aria-expanded={row.expanded}
      onPress={onPress}
      style={rowStyle(theme, layout, row.depth)}
    >
      <Icon name={row.expanded ? "ChevronDown" : "ChevronRight"} size={layout.iconSize} color={theme.colors.foregroundMuted} />
      <Text style={[styles.text, { fontSize: layout.nameSize, fontWeight: "600", flexShrink: 1 }]} numberOfLines={1}>
        {row.name}
      </Text>
      <Text style={styles.label}>{row.count}</Text>
    </Pressable>
  );
}

function FileRow({
  theme,
  styles,
  layout,
  row,
  palette,
  now,
  onPress,
}: ChromeProps & { row: Extract<TreeRow<RecentEntry>, { type: "file" }>; palette: KindPalette; now: number; onPress(): void }) {
  const { entry } = row;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={entryLabel(entry, now, [humanSize(entry.size)])}
      onPress={onPress}
      style={rowStyle(theme, layout, row.depth)}
    >
      <Icon name={KIND_ICON[entry.kind]} size={layout.iconSize} color={kindColor(palette, entry.kind)} />
      <View style={{ flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: 6 }}>
        <Text style={[styles.text, { fontSize: layout.nameSize, flexShrink: 1 }]} numberOfLines={1}>
          {baseName(entry.path)}
        </Text>
        {entry.review || entry.isNew ? <StatusPill theme={theme} styles={styles} status={entry.review ?? "new"} label={layout.status} /> : null}
      </View>
      <Text style={styles.label} numberOfLines={1}>
        {layout.size ? `${humanSize(entry.size)} · ` : ""}
        {relativeTime(entry.mtimeMs, now)}
      </Text>
    </Pressable>
  );
}
