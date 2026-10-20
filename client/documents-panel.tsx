import { type PluginOpenScreenInput, type PluginWorkspacePanelProps, useRpc } from "@getpaseo/plugin/client";
import { FlatList, Icon, ScrollView, TextInput } from "@getpaseo/plugin/client/react-native";
import type { PluginTheme } from "@getpaseo/plugin";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type LayoutChangeEvent, PixelRatio, Pressable, Text, View } from "react-native";
import type { DocumentView } from "../shared/documents-view";
import { layoutClass } from "../shared/viewer-state";
import { countGroups, type DocumentGroup, filterEntries, queryTerms } from "../shared/browse";
import { RECENT_MAX_LIMIT } from "../shared/limits";
import { docsRecentRpc, docsVisitRpc, docThumbnailRpc } from "../shared/rpc";
import { viewerSettingsRpc } from "../shared/settings";
import { baseName, GROUP_FILES, GROUP_ICON, GROUP_LABEL, humanSize, KIND_ICON, parentDir, relativeTime } from "./format";
import { kindColor, type KindPalette } from "./kind-colors";
import { detailsColumns, previewGrid, treeLayout } from "./panel-layout";
import { DetailsHeader, DetailsRow } from "./documents-details";
import { countText, PreviewTile, TileRow, usePreviews } from "./documents-previews";
import { TreeActions, TreeList, useTreeExpansion } from "./documents-tree";
import { ALL_COLLAPSED, ALL_EXPANDED, folderFiles, folderTree, isExpanded, setExpanded, treeRows } from "./folder-tree";
import { type PreviewRow, previewRowKey, previewRows, visibleTilePaths } from "./previews";
import { useDocumentView, VIEW_OPTIONS } from "./documents-view";
import { recentQueryOptions } from "./queries";
import { type BrowseRow, browseRows, documentScreen, entryLabel, filterChips, listFooter, noMatchDetail, type RecentEntry, treeNotice, unsupportedDetail } from "./recent";
import { siblingWindow } from "./siblings";
import { TipsCard, TipsLink, useTips } from "./tips-card";
import { ErrorState, LoadingState, makeStyles, MessageState, StatusPill, statusIcon, type Styles } from "./ui";
import { useBottomInset } from "./use-bottom-inset";
import { useKindPalette } from "./use-kind-colors";
import { documentsVisits } from "./visits";

const SEARCH_DEBOUNCE_MS = 250;
const SWITCH_LABELS_MIN_WIDTH = 600;
const SWITCH_INLINE_MIN_WIDTH = 360;
const NO_GROUPS: ReadonlySet<DocumentGroup> = new Set();
const VIEWABILITY = { itemVisiblePercentThreshold: 1 };

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

// The previous time Documents was opened here, or null the first time; undefined until known.
function useLastVisit(hostId: string | undefined, workspaceId: string): number | null | undefined {
  const scope = `${hostId ?? ""}\0${workspaceId}`;
  const recordVisit = useRpc(docsVisitRpc);
  const [visit, setVisit] = useState(() => ({ scope, since: documentsVisits.peek(scope) }));
  useEffect(() => {
    let live = true;
    documentsVisits.open(scope, async () => (await recordVisit({ workspaceId })).since).then(
      (since) => live && setVisit((current) => (current.scope === scope && current.since === since ? current : { scope, since })),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [scope, workspaceId, recordVisit]);
  return visit.scope === scope ? visit.since : documentsVisits.peek(scope);
}

function DocumentsList({
  theme,
  layout,
  host,
  workspaceId,
  styles,
  openScreen,
}: PluginWorkspacePanelProps & { styles: Styles; openScreen(input: PluginOpenScreenInput): void }) {
  const [query, setQuery] = useState("");
  const [group, setGroup] = useState<DocumentGroup | null>(null);
  const [needsReview, setNeedsReview] = useState(false);
  const [newOnly, setNewOnly] = useState(false);
  const [collapsed, setCollapsed] = useState(NO_GROUPS);
  const [view, setView] = useDocumentView(layoutClass(layout.compact));
  const [width, setWidth] = useState(0);
  // Every return below measures: react-native-web starts observing a View only if it mounts with onLayout,
  // and React keeps the loading state's View for the list.
  const onLayout = (event: LayoutChangeEvent) => setWidth(event.nativeEvent.layout.width);
  const searched = useDebounced(query, SEARCH_DEBOUNCE_MS);
  const newSince = useLastVisit(host?.id, workspaceId);
  const listRecent = useRpc(docsRecentRpc);
  const tree = view === "tree";
  const { request, ...options } = recentQueryOptions(workspaceId, { query: searched, group, needsReview, newOnly, newSince, limit: tree ? RECENT_MAX_LIMIT : undefined });
  const recent = useQuery({ ...options, queryFn: () => listRecent(request) });
  const filtering = queryTerms(query).length > 0 || group !== null || needsReview || newOnly;
  const pending = recent.isPlaceholderData || searched !== query;
  const entries = useMemo(
    () => (recent.data ? filterEntries(recent.data.entries, { query, group, needsReview, newOnly }) : []),
    [recent.data, query, group, needsReview, newOnly],
  );
  const grid = view === "previews" && width > 0 ? previewGrid(width, layout.compact, PixelRatio.get()) : null;
  const previewHeadings = grid !== null && (needsReview || newOnly);
  const rows = useMemo(
    () =>
      recent.data
        ? browseRows(entries, {
            counts: previewHeadings ? countGroups(entries) : recent.data.counts,
            collapsed,
            headers: group === null && (previewHeadings || (!needsReview && !newOnly)),
          })
        : [],
    [entries, recent.data, collapsed, group, needsReview, newOnly, previewHeadings],
  );
  const filterKey = filtering ? JSON.stringify([queryTerms(query), group, needsReview, newOnly]) : null;
  const [expansion, updateExpansion] = useTreeExpansion(`${host?.id ?? ""}\0${workspaceId}`, filterKey);
  const folderRows = useMemo(
    () => (tree ? treeRows(folderTree(entries), (chain, depth) => isExpanded(expansion, chain, depth)) : []),
    [tree, entries, expansion],
  );
  const columnsCount = grid?.columns ?? 0;
  const items: readonly PreviewRow[] = useMemo(() => (columnsCount > 0 ? previewRows(rows, columnsCount) : rows), [rows, columnsCount]);
  const tileEntries = useMemo(() => items.flatMap((item) => (item.type === "tiles" ? item.entries : [])), [items]);
  const [visible, setVisible] = useState<ReadonlySet<string> | null>(null);
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const onViewableItemsChanged = useRef(({ viewableItems }: { viewableItems: { index: number | null }[] }) => {
    const paths = visibleTilePaths(itemsRef.current, viewableItems.flatMap(({ index }) => (index === null ? [] : [index])));
    setVisible((current) => (current && current.size === paths.size && [...paths].every((path) => current.has(path)) ? current : paths));
  }).current;
  const readThumbnail = useRpc(docThumbnailRpc);
  const preview = usePreviews(workspaceId, tileEntries, grid, visible, readThumbnail);
  const openPath = useCallback((path: string) => openScreen(documentScreen(workspaceId, path)), [openScreen, workspaceId]);
  const now = recent.dataUpdatedAt || Date.now();
  const tips = useTips();
  const readSettings = useRpc(viewerSettingsRpc.read);
  const palette = useKindPalette(theme, () => readSettings({}), recent.dataUpdatedAt);
  const tipsCard = tips.step !== null ? <TipsCard theme={theme} styles={styles} step={tips.step} onNext={tips.next} onSkip={tips.skip} /> : null;
  const tipsLink = tips.canReopen ? <TipsLink theme={theme} styles={styles} onPress={tips.reopen} /> : null;

  if (!recent.data) {
    return (
      <View style={styles.screen} onLayout={onLayout}>
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
      <View style={styles.screen} onLayout={onLayout}>
        {tipsCard ? <View style={{ paddingTop: 8 }}>{tipsCard}</View> : null}
        <MessageState
          theme={theme}
          styles={styles}
          icon="FileText"
          title="No documents yet"
          detail="PDF, Word, Excel, CSV, JSON Lines, Parquet, PowerPoint, image, video, and audio files in this workspace appear here"
        >
          {tipsLink}
        </MessageState>
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
    setNewOnly(false);
  };

  const controlHeight = layout.compact ? 44 : 36;
  const columns = view === "details" ? detailsColumns(width, layout.compact) : null;
  const shape = treeLayout(width, layout.compact);
  const switchInline = width === 0 || width >= SWITCH_INLINE_MIN_WIDTH;
  const viewSwitch = (
    <ViewSwitch
      theme={theme}
      styles={styles}
      view={view}
      height={controlHeight}
      labels={!layout.compact && width >= SWITCH_LABELS_MIN_WIDTH}
      stretch={!switchInline}
      onChange={setView}
    />
  );
  const openFromTree = (path: string) => openScreen(documentScreen(workspaceId, path, siblingWindow(folderFiles(folderRows, path), path)));
  const footer =
    recent.data.truncated || tipsLink ? (
      <View style={{ padding: 8, gap: 8 }}>
        {recent.data.truncated && !tree ? <Text style={styles.muted}>{listFooter(entries.length, filtering)}</Text> : null}
        {tipsLink}
      </View>
    ) : null;
  return (
    <View style={styles.screen} onLayout={onLayout}>
      <View style={{ gap: 8, paddingTop: 8, paddingBottom: 8, borderBottomWidth: 1, borderBottomColor: theme.colors.border }}>
        {tipsCard}
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginHorizontal: styles.gutter }}>
          <SearchBox
            theme={theme}
            styles={styles}
            compact={layout.compact}
            shortHint={layout.compact || !switchInline}
            height={controlHeight}
            value={query}
            onChange={setQuery}
          />
          {switchInline ? viewSwitch : null}
        </View>
        {switchInline ? null : <View style={{ marginHorizontal: styles.gutter }}>{viewSwitch}</View>}
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          style={{ flexGrow: 0 }}
          contentContainerStyle={{ gap: 6, paddingHorizontal: styles.gutter }}
        >
          {recent.data.needsReview > 0 || needsReview ? (
            <Chip
              theme={theme}
              styles={styles}
              icon={statusIcon(theme, "changed")}
              label="Needs review"
              count={recent.data.needsReview}
              selected={needsReview}
              onPress={() => setNeedsReview(!needsReview)}
            />
          ) : null}
          {recent.data.newCount > 0 || newOnly ? (
            <Chip theme={theme} styles={styles} icon={statusIcon(theme, "new")} label="New" count={recent.data.newCount} selected={newOnly} onPress={() => setNewOnly(!newOnly)} />
          ) : null}
          {filterChips(recent.data.counts, group).map((chip) => (
            <Chip
              key={chip.group ?? "all"}
              theme={theme}
              styles={styles}
              icon={chip.group ? { name: GROUP_ICON[chip.group], color: palette[chip.group] } : { name: "Files", color: theme.colors.foregroundMuted }}
              label={chip.group ? GROUP_LABEL[chip.group] : "All"}
              count={chip.count}
              selected={chip.group === group}
              onPress={() => setGroup(chip.group)}
            />
          ))}
        </ScrollView>
      </View>
      {tree && entries.length > 0 ? (
        <TreeActions
          theme={theme}
          styles={styles}
          layout={shape}
          notice={treeNotice(recent.data.entries.length, recent.data.truncatedBy, filtering)}
          onExpandAll={() => updateExpansion(() => ALL_EXPANDED)}
          onCollapseAll={() => updateExpansion(() => ALL_COLLAPSED)}
        />
      ) : null}
      {entries.length === 0 ? (
        pending ? (
          <LoadingState theme={theme} styles={styles} />
        ) : (
          <MessageState
            theme={theme}
            styles={styles}
            icon={recent.data.unsupported ? "FileX" : "SearchX"}
            title={recent.data.unsupported ? "Not a supported file type" : "No matching documents"}
            detail={unsupportedDetail(recent.data.unsupported ?? []) ?? noMatchDetail({ query, group, needsReview, newOnly }, recent.data.truncated)}
            action={{ label: "Clear filters", onPress: clearFilters }}
          />
        )
      ) : tree ? (
        <TreeList
          theme={theme}
          styles={styles}
          layout={shape}
          rows={folderRows}
          palette={palette}
          now={now}
          footer={footer}
          onToggle={(chain, open) => updateExpansion((current) => setExpanded(current, chain, open))}
          onOpen={openFromTree}
        />
      ) : (
        <FlatList
          data={items}
          keyExtractor={previewRowKey}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ padding: 8, paddingTop: columns ? 0 : 8, paddingBottom: 8 + styles.bottomInset }}
          ListHeaderComponent={columns ? <DetailsHeader theme={theme} columns={columns} /> : null}
          stickyHeaderIndices={columns ? [0] : undefined}
          onViewableItemsChanged={onViewableItemsChanged}
          viewabilityConfig={VIEWABILITY}
          renderItem={({ item }: { item: PreviewRow }) =>
            item.type === "tiles" && grid ? (
              <TileRow grid={grid}>
                {item.entries.map((entry) => {
                  const { thumbnail, loading } = preview(entry);
                  const count = thumbnail?.count;
                  return (
                    <PreviewTile
                      key={entry.path}
                      theme={theme}
                      styles={styles}
                      palette={palette}
                      entry={entry}
                      thumbnail={thumbnail}
                      loading={loading}
                      size={grid.cellWidth}
                      label={entryLabel(entry, now, count === undefined ? [] : [countText(entry.kind, count)])}
                      when={relativeTime(entry.mtimeMs, now)}
                      onOpen={openPath}
                    />
                  );
                })}
              </TileRow>
            ) : item.type === "tiles" ? null : item.type === "header" ? (
              <GroupHeader
                theme={theme}
                styles={styles}
                row={item}
                variant={columns ? { type: "details", rowHeight: columns.rowHeight } : { type: "list" }}
                onToggle={() => toggle(item.group)}
                onShowAll={() => setGroup(item.group)}
              />
            ) : columns ? (
              <DetailsRow
                theme={theme}
                styles={styles}
                columns={columns}
                entry={item.entry}
                palette={palette}
                now={now}
                onPress={() => openScreen(documentScreen(workspaceId, item.entry.path))}
              />
            ) : (
              <EntryRow
                theme={theme}
                styles={styles}
                entry={item.entry}
                palette={palette}
                now={now}
                onPress={() => openScreen(documentScreen(workspaceId, item.entry.path))}
              />
            )
          }
          ListFooterComponent={footer}
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
  compact,
  shortHint,
  height,
  value,
  onChange,
}: ChromeProps & { compact: boolean; shortHint: boolean; height: number; value: string; onChange(value: string): void }) {
  return (
    <View
      style={{
        flex: 1,
        minWidth: 0,
        flexDirection: "row",
        alignItems: "center",
        gap: 6,
        height,
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
        placeholder={shortHint ? "Search documents" : "Search by name or folder"}
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

function ViewSwitch({
  theme,
  styles,
  view,
  height,
  labels,
  onChange,
  stretch,
}: ChromeProps & { view: DocumentView; height: number; labels: boolean; stretch: boolean; onChange(view: DocumentView): void }) {
  return (
    <View style={{ flexDirection: "row", height, padding: styles.compact ? 1 : 2, gap: 2, borderWidth: 1, borderColor: theme.colors.border, borderRadius: 8, backgroundColor: theme.colors.surface1 }}>
      {VIEW_OPTIONS.map((option) => {
        const selected = option.view === view;
        const color = selected ? theme.colors.foreground : theme.colors.foregroundMuted;
        return (
          <Pressable
            key={option.view}
            accessibilityRole="button"
            accessibilityLabel={option.spoken}
            accessibilityState={{ selected }}
            aria-pressed={selected}
            hitSlop={styles.hitSlop}
            onPress={() => onChange(option.view)}
            style={({ pressed, hovered }: { pressed: boolean; hovered?: boolean }) => ({
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "center",
              gap: 6,
              minWidth: styles.compact ? 40 : 30,
              flex: stretch ? 1 : undefined,
              paddingHorizontal: labels ? 10 : 0,
              borderRadius: 6,
              backgroundColor: selected ? theme.colors.surface2 : pressed || hovered ? theme.colors.surface0 : "transparent",
            })}
          >
            <Icon name={option.icon} size={14} color={color} />
            {labels ? <Text style={{ color, fontSize: 12, fontWeight: selected ? "600" : "400" }}>{option.label}</Text> : null}
          </Pressable>
        );
      })}
    </View>
  );
}

function Chip({
  theme,
  styles,
  icon,
  label,
  count,
  selected,
  onPress,
}: ChromeProps & {
  icon: { name: string; color: string };
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
      aria-pressed={selected}
      hitSlop={styles.hitSlop}
      onPress={onPress}
      style={({ pressed, hovered }: { pressed: boolean; hovered?: boolean }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: 6,
        height: styles.controlSize,
        paddingLeft: 10,
        paddingRight: 12,
        borderRadius: styles.controlSize / 2,
        borderWidth: 1,
        borderColor: selected ? theme.colors.surface2 : theme.colors.border,
        backgroundColor: selected ? theme.colors.surface2 : pressed || hovered ? theme.colors.surface1 : "transparent",
      })}
    >
      <View aria-hidden>
        <Icon name={icon.name} size={styles.compact ? 14 : 12} color={icon.color} />
      </View>
      <Text style={{ color, fontSize: 12, fontWeight: selected ? "600" : "400" }} numberOfLines={1}>
        {label}
      </Text>
      <Text style={{ color: selected ? color : theme.colors.foregroundMuted, fontSize: 12, fontVariant: ["tabular-nums"] }}>
        {count}
      </Text>
    </Pressable>
  );
}

const GROUP_HEADER_LOOK = {
  list: { marginTop: 4, paddingVertical: 6, fontSize: 13 },
  details: { marginTop: 2, paddingVertical: 0, fontSize: 12 },
} as const;

function GroupHeader({
  theme,
  styles,
  row,
  variant,
  onToggle,
  onShowAll,
}: ChromeProps & {
  row: Extract<BrowseRow, { type: "header" }>;
  variant: { type: "list" } | { type: "details"; rowHeight: number };
  onToggle(): void;
  onShowAll(): void;
}) {
  const label = GROUP_LABEL[row.group];
  const count = row.shown < row.total ? `${row.shown} of ${row.total}` : String(row.total);
  const look = GROUP_HEADER_LOOK[variant.type];
  const minHeight = variant.type === "details" ? variant.rowHeight : undefined;
  return (
    <View style={{ flexDirection: "row", alignItems: "center", marginTop: look.marginTop }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${label}, ${count}`}
        accessibilityState={{ expanded: !row.collapsed }}
        aria-expanded={!row.collapsed}
        onPress={onToggle}
        style={{ flex: 1, flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 8, paddingVertical: look.paddingVertical, minHeight }}
      >
        <Icon name={row.collapsed ? "ChevronRight" : "ChevronDown"} size={14} color={theme.colors.foregroundMuted} />
        <Text style={[styles.text, { fontSize: look.fontSize, fontWeight: "600" }]}>{label}</Text>
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
  palette,
  now,
  onPress,
}: ChromeProps & { entry: RecentEntry; palette: KindPalette; now: number; onPress(): void }) {
  const directory = parentDir(entry.path);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={entryLabel(entry, now)}
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
      <Icon name={KIND_ICON[entry.kind]} size={16} color={kindColor(palette, entry.kind)} />
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6, minWidth: 0 }}>
          <Text style={[styles.text, { flexShrink: 1 }]} numberOfLines={1}>
            {baseName(entry.path)}
          </Text>
          {entry.review || entry.isNew ? (
            <StatusPill theme={theme} styles={styles} status={entry.review ?? "new"} label={styles.compact ? "short" : "full"} />
          ) : null}
        </View>
        <Text style={styles.muted} numberOfLines={1}>
          {directory ? `${directory} · ` : ""}
          {humanSize(entry.size)}
        </Text>
      </View>
      <Text style={styles.label}>{relativeTime(entry.mtimeMs, now)}</Text>
    </Pressable>
  );
}
