import type { PluginTheme } from "@getpaseo/plugin";
import { FlatList, Icon } from "@getpaseo/plugin/client/react-native";
import { memo, type ReactElement, useCallback, useEffect, useState } from "react";
import { Platform, Pressable, Text, View } from "react-native";
import { baseName, humanSize, KIND_ICON, relativeTime } from "./format";
import { folderLabel, treeExpansions, type TreeExpansion, type TreeRow } from "./folder-tree";
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
// The notice keeps this much room beside Expand all and Collapse all, or takes a row of its own above them.
const NOTICE_MIN_WIDTH = 240;

// On the web the rows form a tree: react-native-web passes role and aria-level through. It presses on Space
// only for role="button", so a tree item takes Space itself, as in a tree. React Native has no tree role,
// so there the rows stay buttons and a folder's label speaks its level.
const WEB = Platform.OS === "web";
const treeItem = (depth: number, activate: () => void) =>
  WEB
    ? {
        role: "treeitem" as const,
        "aria-level": depth + 1,
        onKeyDown: (event: { key: string; repeat: boolean; preventDefault(): void }) => {
          if (event.key !== " ") return;
          event.preventDefault();
          if (!event.repeat) activate();
        },
      }
    : {};

const expansions = treeExpansions(50);

export function useTreeExpansion(scope: string, filterKey: string | null): [TreeExpansion, (change: (current: TreeExpansion) => TreeExpansion) => void] {
  const key = expansions.key(scope, filterKey);
  const [state, setState] = useState(() => ({ key, expansion: expansions.start(scope, filterKey) }));
  // A change that leaves the expansion as it is leaves the state as it is, so it draws nothing.
  const update = useCallback(
    (change: (current: TreeExpansion) => TreeExpansion) =>
      setState((current) => {
        const expansion = change(current.key === key ? current.expansion : expansions.start(scope, filterKey));
        return current.key === key && expansion === current.expansion ? current : { key, expansion };
      }),
    [key, scope, filterKey],
  );
  useEffect(() => {
    if (filterKey === null && state.key === key) expansions.save(scope, state.expansion);
  }, [state, key, scope, filterKey]);
  return [state.key === key ? state.expansion : expansions.start(scope, filterKey), update];
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
    <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8, paddingHorizontal: 8 + ROW_PADDING, paddingTop: 8 }}>
      {notice ? <Text style={[styles.muted, { flexGrow: 1, flexShrink: 1, flexBasis: NOTICE_MIN_WIDTH }]}>{notice}</Text> : null}
      <View style={{ flexDirection: "row", gap: 8, marginLeft: "auto" }}>
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
  onToggle(path: string, open: boolean): void;
  onOpen(path: string): void;
}) {
  // Rows take only values that survive a poll, so an unchanged row is not drawn again.
  const renderItem = useCallback(
    ({ item }: { item: TreeRow<RecentEntry> }) =>
      item.type === "folder" ? (
        <FolderRow
          theme={theme}
          styles={styles}
          layout={layout}
          path={item.path}
          name={item.name}
          parent={item.parent}
          depth={item.depth}
          count={item.count}
          expanded={item.expanded}
          onToggle={onToggle}
        />
      ) : (
        <FileRow theme={theme} styles={styles} layout={layout} entry={item.entry} depth={item.depth} palette={palette} now={now} onOpen={onOpen} />
      ),
    [theme, styles, layout, palette, now, onToggle, onOpen],
  );
  return (
    <FlatList
      {...(WEB ? { role: "tree" as const, accessibilityLabel: "Documents by folder" } : {})}
      data={rows}
      keyExtractor={rowKey}
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={{ padding: 8, paddingBottom: 8 + styles.bottomInset }}
      renderItem={renderItem}
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

const FolderRow = memo(function FolderRow({
  theme,
  styles,
  layout,
  path,
  name,
  parent,
  depth,
  count,
  expanded,
  onToggle,
}: ChromeProps & { path: string; name: string; parent: string; depth: number; count: number; expanded: boolean; onToggle(path: string, open: boolean): void }) {
  const toggle = () => onToggle(path, !expanded);
  return (
    <Pressable
      accessibilityRole="button"
      {...treeItem(depth, toggle)}
      accessibilityLabel={folderLabel({ name, parent, count }, WEB ? undefined : depth + 1)}
      aria-expanded={expanded}
      onPress={toggle}
      style={rowStyle(theme, layout, depth)}
    >
      <Icon name={expanded ? "ChevronDown" : "ChevronRight"} size={layout.iconSize} color={theme.colors.foregroundMuted} />
      <Text style={[styles.text, { fontSize: layout.nameSize, fontWeight: "600", flexShrink: 1 }]} numberOfLines={1}>
        {name}
      </Text>
      <Text style={styles.label}>{count}</Text>
    </Pressable>
  );
});

const sameEntry = (a: RecentEntry, b: RecentEntry) =>
  Object.keys(a).length === Object.keys(b).length && (Object.keys(a) as (keyof RecentEntry)[]).every((field) => a[field] === b[field]);

// The entry by value: a poll that moves a changed file to the top hands over the entries after it as copies.
const sameFileRow = <P extends { entry: RecentEntry }>(a: P, b: P) =>
  (Object.keys(a) as (keyof P)[]).every((key) => (key === "entry" ? sameEntry(a.entry, b.entry) : a[key] === b[key]));

const FileRow = memo(function FileRow({
  theme,
  styles,
  layout,
  entry,
  depth,
  palette,
  now,
  onOpen,
}: ChromeProps & { entry: RecentEntry; depth: number; palette: KindPalette; now: number; onOpen(path: string): void }) {
  const open = () => onOpen(entry.path);
  return (
    <Pressable
      accessibilityRole="button"
      {...treeItem(depth, open)}
      accessibilityLabel={entryLabel(entry, now, [humanSize(entry.size)])}
      onPress={open}
      style={rowStyle(theme, layout, depth)}
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
}, sameFileRow);
