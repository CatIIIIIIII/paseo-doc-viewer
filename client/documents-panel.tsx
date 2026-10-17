import { type PluginOpenScreenInput, type PluginWorkspacePanelProps, useRpc } from "@getpaseo/plugin/client";
import { FlatList, Icon, ScrollView, TextInput } from "@getpaseo/plugin/client/react-native";
import type { PluginTheme } from "@getpaseo/plugin";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { type DocumentGroup, filterEntries, queryTerms } from "../shared/browse";
import { docsRecentRpc } from "../shared/rpc";
import { baseName, GROUP_FILES, GROUP_LABEL, humanSize, KIND_ICON, KIND_LABEL, parentDir, relativeTime } from "./format";
import { recentQueryOptions } from "./queries";
import { type BrowseRow, browseRows, documentScreen, filterChips, listFooter, noMatchDetail, type RecentEntry } from "./recent";
import { ErrorState, LoadingState, makeStyles, MessageState, type Styles } from "./ui";
import { useBottomInset } from "./use-bottom-inset";

const SEARCH_DEBOUNCE_MS = 250;
const NO_GROUPS: ReadonlySet<DocumentGroup> = new Set();

function useDebounced<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

export function createDocumentsPanel(openScreen: (input: PluginOpenScreenInput) => void) {
  return function DocumentsPanel(props: PluginWorkspacePanelProps) {
    const { ref, onLayout, bottomInset } = useBottomInset();
    const styles = useMemo(() => makeStyles(props.theme, props.layout.compact, bottomInset), [props.theme, props.layout.compact, bottomInset]);
    return (
      <View ref={ref} onLayout={onLayout} style={{ flex: 1 }}>
        <DocumentsList {...props} styles={styles} openScreen={openScreen} />
      </View>
    );
  };
}

function DocumentsList({
  theme,
  layout,
  workspaceId,
  styles,
  openScreen,
}: PluginWorkspacePanelProps & { styles: Styles; openScreen(input: PluginOpenScreenInput): void }) {
  const [query, setQuery] = useState("");
  const [group, setGroup] = useState<DocumentGroup | null>(null);
  const [needsReview, setNeedsReview] = useState(false);
  const [collapsed, setCollapsed] = useState(NO_GROUPS);
  const searched = useDebounced(query, SEARCH_DEBOUNCE_MS);
  const listRecent = useRpc(docsRecentRpc);
  const { request, ...options } = recentQueryOptions(workspaceId, { query: searched, group, needsReview });
  const recent = useQuery({ ...options, queryFn: () => listRecent(request) });
  const filtering = queryTerms(query).length > 0 || group !== null || needsReview;
  const pending = recent.isPlaceholderData || searched !== query;
  const entries = useMemo(() => (recent.data ? filterEntries(recent.data.entries, { query, group, needsReview }) : []), [recent.data, query, group, needsReview]);
  const rows = useMemo(
    () => (recent.data ? browseRows(entries, { counts: recent.data.counts, collapsed, headers: group === null && !needsReview }) : []),
    [entries, recent.data, collapsed, group, needsReview],
  );
  const now = recent.dataUpdatedAt || Date.now();

  if (!recent.data) {
    return (
      <View style={styles.screen}>
        {recent.error ? (
          <ErrorState theme={theme} styles={styles} error={recent.error} onRetry={() => void recent.refetch()} />
        ) : (
          <LoadingState theme={theme} styles={styles} />
        )}
      </View>
    );
  }
  if (recent.data.entries.length === 0 && !filtering && !pending) {
    return (
      <View style={styles.screen}>
        <MessageState
          theme={theme}
          styles={styles}
          icon="FileStack"
          title="No documents yet"
          detail="PDF, Word, Excel, CSV, PowerPoint, image, video, and audio files in this workspace appear here"
        />
      </View>
    );
  }

  const toggle = (target: DocumentGroup) =>
    setCollapsed((current) => {
      const next = new Set(current);
      if (!next.delete(target)) next.add(target);
      return next;
    });
  const clearFilters = () => {
    setQuery("");
    setGroup(null);
    setNeedsReview(false);
  };

  return (
    <View style={styles.screen}>
      <View style={{ gap: 8, paddingTop: 8, paddingBottom: 8, borderBottomWidth: 1, borderBottomColor: theme.colors.border }}>
        <SearchBox theme={theme} styles={styles} compact={layout.compact} value={query} onChange={setQuery} />
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          style={{ flexGrow: 0 }}
          contentContainerStyle={{ gap: 6, paddingHorizontal: styles.gutter }}
        >
          {filterChips(recent.data.counts, group).map((chip) => (
            <Chip
              key={chip.group ?? "all"}
              theme={theme}
              label={chip.group ? GROUP_LABEL[chip.group] : "All"}
              count={chip.count}
              selected={chip.group === group}
              onPress={() => setGroup(chip.group)}
            />
          ))}
          {recent.data.needsReview > 0 || needsReview ? (
            <Chip theme={theme} label="Needs review" count={recent.data.needsReview} selected={needsReview} onPress={() => setNeedsReview(!needsReview)} />
          ) : null}
        </ScrollView>
      </View>
      {entries.length === 0 ? (
        pending ? (
          <LoadingState theme={theme} styles={styles} />
        ) : (
          <MessageState
            theme={theme}
            styles={styles}
            icon="SearchX"
            title="No matching documents"
            detail={noMatchDetail({ query, group, needsReview }, recent.data.truncated)}
            action={{ label: "Clear filters", onPress: clearFilters }}
          />
        )
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(row: BrowseRow) => (row.type === "header" ? `group:${row.group}` : row.entry.path)}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ padding: 8, paddingBottom: 8 + styles.bottomInset }}
          renderItem={({ item }: { item: BrowseRow }) =>
            item.type === "header" ? (
              <GroupHeader
                theme={theme}
                styles={styles}
                row={item}
                onToggle={() => toggle(item.group)}
                onShowAll={() => setGroup(item.group)}
              />
            ) : (
              <EntryRow
                theme={theme}
                styles={styles}
                entry={item.entry}
                now={now}
                onPress={() => openScreen(documentScreen(workspaceId, item.entry.path))}
              />
            )
          }
          ListFooterComponent={
            recent.data.truncated ? (
              <Text style={[styles.muted, { padding: 8 }]}>{listFooter(entries.length, filtering)}</Text>
            ) : null
          }
        />
      )}
    </View>
  );
}

interface ChromeProps {
  theme: PluginTheme;
  styles: Styles;
}

function SearchBox({
  theme,
  styles,
  compact,
  value,
  onChange,
}: ChromeProps & { compact: boolean; value: string; onChange(value: string): void }) {
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 6,
        height: 36,
        marginHorizontal: styles.gutter,
        paddingLeft: 10,
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: 8,
        backgroundColor: theme.colors.surface1,
      }}
    >
      <Icon name="Search" size={14} color={theme.colors.foregroundMuted} />
      <TextInput
        value={value}
        onChangeText={onChange}
        placeholder="Search by name or folder"
        placeholderTextColor={theme.colors.foregroundMuted}
        accessibilityLabel="Search documents"
        autoCapitalize="none"
        autoCorrect={false}
        returnKeyType="search"
        style={{ flex: 1, minWidth: 0, height: "100%", padding: 0, color: theme.colors.foreground, fontSize: compact ? 16 : 14, outlineWidth: 0 }}
      />
      {value ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Clear search"
          onPress={() => onChange("")}
          hitSlop={8}
          style={{ paddingHorizontal: 10, height: "100%", justifyContent: "center" }}
        >
          <Icon name="X" size={14} color={theme.colors.foregroundMuted} />
        </Pressable>
      ) : (
        <View style={{ width: 10 }} />
      )}
    </View>
  );
}

function Chip({
  theme,
  label,
  count,
  selected,
  onPress,
}: {
  theme: PluginTheme;
  label: string;
  count: number;
  selected: boolean;
  onPress(): void;
}) {
  const color = theme.colors.foreground;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${label}, ${count} ${count === 1 ? "document" : "documents"}`}
      accessibilityState={{ selected }}
      onPress={onPress}
      style={({ pressed, hovered }: { pressed: boolean; hovered?: boolean }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: 6,
        height: 28,
        paddingHorizontal: 12,
        borderRadius: 14,
        borderWidth: 1,
        borderColor: selected ? theme.colors.surface2 : theme.colors.border,
        backgroundColor: selected ? theme.colors.surface2 : pressed || hovered ? theme.colors.surface1 : "transparent",
      })}
    >
      <Text style={{ color, fontSize: 12, fontWeight: selected ? "600" : "400" }} numberOfLines={1}>
        {label}
      </Text>
      <Text style={{ color: selected ? color : theme.colors.foregroundMuted, fontSize: 12, fontVariant: ["tabular-nums"] }}>
        {count}
      </Text>
    </Pressable>
  );
}

function GroupHeader({
  theme,
  styles,
  row,
  onToggle,
  onShowAll,
}: ChromeProps & { row: Extract<BrowseRow, { type: "header" }>; onToggle(): void; onShowAll(): void }) {
  const label = GROUP_LABEL[row.group];
  const count = row.shown < row.total ? `${row.shown} of ${row.total}` : String(row.total);
  return (
    <View style={{ flexDirection: "row", alignItems: "center", marginTop: 4 }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${label}, ${count}`}
        accessibilityState={{ expanded: !row.collapsed }}
        onPress={onToggle}
        style={{ flex: 1, flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 8, paddingVertical: 6 }}
      >
        <Icon name={row.collapsed ? "ChevronRight" : "ChevronDown"} size={14} color={theme.colors.foregroundMuted} />
        <Text style={[styles.text, { fontSize: 13, fontWeight: "600" }]}>{label}</Text>
        <Text style={styles.label}>{count}</Text>
      </Pressable>
      {row.shown < row.total ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Show all ${row.total} ${GROUP_FILES[row.group]}`}
          onPress={onShowAll}
          hitSlop={6}
          style={{ paddingHorizontal: 8, paddingVertical: 6 }}
        >
          <Text style={[styles.muted, { textDecorationLine: "underline" }]}>Show all</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

function EntryRow({
  theme,
  styles,
  entry,
  now,
  onPress,
}: ChromeProps & { entry: RecentEntry; now: number; onPress(): void }) {
  const directory = parentDir(entry.path);
  const review = entry.review === "changed" ? ", changed since review" : entry.review === "reviewed" ? ", reviewed" : "";
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Open ${entry.path}, ${KIND_LABEL[entry.kind]}, changed ${relativeTime(entry.mtimeMs, now)}${review}`}
      onPress={onPress}
      style={({ pressed, hovered }: { pressed: boolean; hovered?: boolean }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: 12,
        paddingHorizontal: 8,
        paddingVertical: 8,
        borderRadius: 8,
        backgroundColor: pressed || hovered ? theme.colors.surface2 : "transparent",
      })}
    >
      <Icon name={KIND_ICON[entry.kind]} size={16} color={theme.colors.foregroundMuted} />
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6, minWidth: 0 }}>
          <Text style={[styles.text, { flexShrink: 1 }]} numberOfLines={1}>
            {baseName(entry.path)}
          </Text>
          {entry.review === "reviewed" ? <Icon name="Check" size={12} color={theme.colors.statusSuccess} /> : null}
        </View>
        <Text style={styles.muted} numberOfLines={1}>
          {entry.review === "changed" ? <Text style={{ color: theme.colors.statusWarning }}>Changed since review · </Text> : null}
          {directory ? `${directory} · ` : ""}
          {humanSize(entry.size)}
        </Text>
      </View>
      <Text style={styles.label}>{relativeTime(entry.mtimeMs, now)}</Text>
    </Pressable>
  );
}
