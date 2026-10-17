import type { SearchNavigation } from "../shared/search";
import { CellInspector } from "./cell-inspector";
import { Highlight } from "./highlight";
import { HeaderChooser, RecordCard } from "./record-view";
import type { ViewerPosition } from "../shared/viewer-state";
import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { FlatList } from "@getpaseo/plugin/client/react-native";
import { useQuery } from "@tanstack/react-query";
import { memo, useCallback, useEffect, useMemo, useReducer, useState } from "react";
import { ActivityIndicator, Platform, ScrollView, Text, useWindowDimensions, View, type TextStyle } from "react-native";
import { docRowsRpc, type DocOpenOutput } from "../shared/rpc";
import { columnName, gridReducer, INITIAL_GRID, rangeLabel, reconcileGrid, retryPage, sheetWindow } from "./paging";
import { rowsQueryKey } from "./queries";
import { ErrorState, LoadingState, MessageState, type Styles, ToolbarButton } from "./ui";

type Sheet = Extract<DocOpenOutput, { sheets: unknown }>["sheets"][number];

export interface SheetViewerProps {
  navigation?: SearchNavigation | null;
  initialPosition?: ViewerPosition | null;
  onPositionChange?: (position: ViewerPosition) => void;
  workspaceId: string;
  path: string;
  revision: string;
  sheets: readonly Sheet[];
  theme: PluginTheme;
  styles: Styles;
}

const CELL_WIDTH = 140;
const ROW_HEIGHT = 32;
const ROW_NUMBER_WIDTH = 56;

export function SheetViewer({ workspaceId, path, revision, sheets, theme, styles, initialPosition, onPositionChange, navigation }: SheetViewerProps) {
  const fetchRows = useRpc(docRowsRpc);
  const viewport = useWindowDimensions();
  const layout = sheetWindow(viewport, { width: CELL_WIDTH, height: ROW_HEIGHT });
  const [stored, dispatch] = useReducer(gridReducer, INITIAL_GRID, () => {
    if (initialPosition?.type !== "grid") return INITIAL_GRID;
    return { ...INITIAL_GRID, sheet: initialPosition.sheet, rowOffset: initialPosition.rowOffset, columnOffset: initialPosition.columnOffset,
      rowHistory: initialPosition.rowOffset > 0 ? [0] : [], columnHistory: initialPosition.columnOffset > 0 ? [0] : [] };
  });
  const [selected, setSelected] = useState<CellRef | null>(null);
  const onSelect = useCallback((cell: CellRef) => setSelected(cell), []);
  const [mode, setMode] = useState<"grid" | "records">("grid");
  const [headers, setHeaders] = useState<ReadonlyMap<number, number | null>>(() => new Map());
  const [choosingHeader, setChoosingHeader] = useState(false);
  const [recordStart, setRecordStart] = useState(0);
  const jump = useCallback((target: { sheet: number; row: number; column: number }) => {
    setMode("grid");
    dispatch({ type: "reconcile", state: { ...INITIAL_GRID, sheet: target.sheet, rowOffset: target.row, columnOffset: target.column,
      rowHistory: target.row > 0 ? [0] : [], columnHistory: target.column > 0 ? [0] : [] } });
    setSelected({ row: target.row, column: target.column });
  }, []);
  useEffect(() => {
    if (navigation?.target.type === "cell") jump(navigation.target);
  }, [navigation, jump]);
  const grid = reconcileGrid(stored, sheets);
  useEffect(() => {
    if (grid !== stored) dispatch({ type: "reconcile", state: grid });
  }, [grid, stored]);
  const sheet = sheets[grid.sheet];
  useEffect(() => {
    if (sheet) onPositionChange?.({ type: "grid", sheet: grid.sheet, rowOffset: grid.rowOffset, columnOffset: grid.columnOffset });
  }, [grid.sheet, grid.rowOffset, grid.columnOffset, sheet, onPositionChange]);
  const rows = useQuery({
    queryKey: rowsQueryKey(workspaceId, path, revision, grid, layout.columns),
    queryFn: () =>
      fetchRows({
        workspaceId,
        path,
        sheet: grid.sheet,
        rowOffset: grid.rowOffset,
        columnOffset: grid.columnOffset,
        maxColumns: layout.columns,
      }),
    enabled: sheet !== undefined && mode === "grid",
    retry: retryPage,
    placeholderData: (previous) => (previous?.sheet === grid.sheet ? previous : undefined),
    staleTime: Infinity,
  });

  const cells = useMemo(() => gridStyles(theme, styles), [theme, styles]);

  if (!sheet) {
    return (
      <View style={styles.screen}>
        <MessageState theme={theme} styles={styles} icon="FileSpreadsheet" title="This workbook has no sheets" />
      </View>
    );
  }

  const modeSwitch = (
    <View style={styles.toolbarGroup}>
      <ToolbarButton theme={theme} styles={styles} label="Grid" selected={mode === "grid"} onPress={() => setMode("grid")} />
      <ToolbarButton theme={theme} styles={styles} label="Records" selected={mode === "records"}
        onPress={() => {
          setRecordStart(selected?.row ?? grid.rowOffset);
          setChoosingHeader(false);
          setMode("records");
        }} />
    </View>
  );
  const recordSheet = { index: grid.sheet, ...sheet };
  const header = headers.get(grid.sheet);
  const common = { workspaceId, path, revision, sheet: recordSheet, theme, styles, leading: modeSwitch };
  const sheetTabs = sheets.length > 1 ? (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      style={{ flexGrow: 0, borderBottomWidth: 1, borderBottomColor: theme.colors.border }}
      contentContainerStyle={{ gap: 4, paddingHorizontal: styles.gutter, paddingVertical: 8 }}
    >
      {sheets.map((candidate, index) => (
        <ToolbarButton
          key={`${index}-${candidate.name}`}
          theme={theme}
          styles={styles}
          label={candidate.name || `Sheet ${index + 1}`}
          selected={index === grid.sheet}
          onPress={() => {
            setSelected(null);
            setChoosingHeader(false);
            setRecordStart(0);
            dispatch({ type: "sheet", sheet: index });
          }}
        />
      ))}
    </ScrollView>
  ) : null;

  if (mode === "records") {
    return (
      <View style={styles.screen}>
        {sheetTabs}
        {header === undefined || choosingHeader ? (
          <HeaderChooser key={grid.sheet} {...common} onChoose={(chosen) => {
            setHeaders(new Map(headers).set(grid.sheet, chosen));
            setChoosingHeader(false);
          }} />
        ) : (
          <RecordCard key={`${grid.sheet}:${header}`} {...common} header={header} initialRow={recordStart}
            onChangeHeader={() => setChoosingHeader(true)}
            onShowInGrid={(row) => jump({ sheet: grid.sheet, row, column: grid.columnOffset })} />
        )}
      </View>
    );
  }

  const data = rows.data;
  const columnCount = data ? Math.max(0, ...data.rows.map((row) => row.length)) : 0;
  const selectedValue = data && selected ? data.rows[selected.row - data.rowOffset]?.[selected.column - data.columnOffset] : undefined;

  return (
    <View style={styles.screen}>
      {sheetTabs}
      <View style={[styles.toolbar, { flexWrap: "wrap" }]}>
        {modeSwitch}
        <ToolbarButton theme={theme} styles={styles} icon="RotateCcw" accessibilityLabel="Reset reading position"
          onPress={() => { setSelected(null); dispatch({ type: "reconcile", state: INITIAL_GRID }); }} />
        <View style={styles.toolbarGroup}>
          <ToolbarButton
            theme={theme}
            styles={styles}
            icon="ChevronUp"
            accessibilityLabel="Previous rows"
            disabled={grid.rowHistory.length === 0}
            onPress={() => dispatch({ type: "prevRows" })}
          />
          <Text style={[styles.label, styles.rangeLabel]}>
            {rangeLabel("rows", grid.rowOffset, data?.rows.length ?? 0, data?.rowCount ?? sheet.rowCount, {
              approximate: data?.countsApproximate ?? sheet.countsApproximate,
              more: data?.nextRowOffset != null,
            })}
          </Text>
          <ToolbarButton
            theme={theme}
            styles={styles}
            icon="ChevronDown"
            accessibilityLabel="Next rows"
            disabled={!data || data.nextRowOffset === null}
            onPress={() => dispatch({ type: "nextRows", offset: data?.nextRowOffset ?? null })}
          />
        </View>
        <View style={styles.toolbarSpacer} />
        <View style={{ width: 16, alignItems: "center" }}>
          {rows.isFetching ? <ActivityIndicator size="small" color={theme.colors.foregroundMuted} /> : null}
        </View>
        <View style={styles.toolbarGroup}>
          <ToolbarButton
            theme={theme}
            styles={styles}
            icon="ChevronLeft"
            accessibilityLabel="Previous columns"
            disabled={grid.columnHistory.length === 0}
            onPress={() => dispatch({ type: "prevColumns" })}
          />
          <Text style={[styles.label, styles.rangeLabel]}>
            {rangeLabel("columns", grid.columnOffset, columnCount, data?.columnCount ?? sheet.columnCount, {
              approximate: data?.countsApproximate ?? sheet.countsApproximate,
              more: data?.nextColumnOffset != null,
            })}
          </Text>
          <ToolbarButton
            theme={theme}
            styles={styles}
            icon="ChevronRight"
            accessibilityLabel="Next columns"
            disabled={!data || data.nextColumnOffset === null}
            onPress={() => dispatch({ type: "nextColumns", offset: data?.nextColumnOffset ?? null })}
          />
        </View>
      </View>
      {selected ? (
        <CellInspector
          workspaceId={workspaceId}
          path={path}
          revision={revision}
          sheetName={sheet.name}
          target={{ sheet: grid.sheet, ...selected }}
          shown={selectedValue ? <Highlight text={selectedValue} query={navigation?.query} theme={theme} active={navigation?.target.type === "cell" && navigation.target.sheet === grid.sheet &&
            navigation.target.row === selected.row && navigation.target.column === selected.column ? navigation.start : undefined} /> : null}
          theme={theme}
          styles={styles}
          onClose={() => setSelected(null)}
        />
      ) : null}
      {rows.error && !data ? (
        <ErrorState theme={theme} styles={styles} error={rows.error} onRetry={() => void rows.refetch()} />
      ) : !data ? (
        <LoadingState theme={theme} styles={styles} />
      ) : data.rows.length === 0 ? (
        <MessageState theme={theme} styles={styles} icon="FileSpreadsheet" title="This sheet is empty" />
      ) : (
        <ScrollView key={`${data.sheet}:${data.rowOffset}:${data.columnOffset}`} horizontal style={{ flex: 1 }}>
          <View style={{ flex: 1 }}>
            <View style={{ flexDirection: "row", backgroundColor: theme.colors.surface1 }}>
              <Text style={[cells.cell, cells.rowNumber]} />
              {Array.from({ length: columnCount }, (_, column) => (
                <Text key={column} style={[cells.cell, cells.header]} numberOfLines={1}>
                  {columnName(data.columnOffset + column)}
                </Text>
              ))}
            </View>
            <FlatList
              data={data.rows}
              contentContainerStyle={{ paddingBottom: styles.bottomInset }}
              keyExtractor={(_, row) => String(data.rowOffset + row)}
              getItemLayout={(_, row) => ({ length: ROW_HEIGHT, offset: ROW_HEIGHT * row, index: row })}
              initialNumToRender={layout.rowsPerScreen}
              maxToRenderPerBatch={layout.rowsPerScreen}
              windowSize={layout.windowSize}
              removeClippedSubviews={Platform.OS === "android"}
              renderItem={({ item, index: row }) => (
                <SheetRow
                  values={item}
                  row={data.rowOffset + row}
                  columnOffset={data.columnOffset}
                  columnCount={columnCount}
                  selectedColumn={selected?.row === data.rowOffset + row ? selected.column : -1}
                  cells={cells}
                  onSelect={onSelect}
                />
              )}
            />
          </View>
        </ScrollView>
      )}
    </View>
  );
}

function gridStyles(theme: PluginTheme, styles: Styles) {
  const cell: TextStyle = {
    width: CELL_WIDTH,
    height: ROW_HEIGHT,
    lineHeight: ROW_HEIGHT - 1,
    paddingHorizontal: 8,
    textAlignVertical: "center",
    borderColor: theme.colors.border,
    borderRightWidth: 1,
    borderBottomWidth: 1,
  };
  const header: TextStyle = { ...styles.label, lineHeight: ROW_HEIGHT - 1 };
  const rowNumber: TextStyle = { ...header, width: ROW_NUMBER_WIDTH, backgroundColor: theme.colors.surface1 };
  const value: TextStyle = { ...styles.text, lineHeight: ROW_HEIGHT - 1 };
  const selected: TextStyle = { backgroundColor: theme.colors.accent, color: theme.colors.accentForeground };
  return { cell, header, rowNumber, value, selected };
}

type GridStyles = ReturnType<typeof gridStyles>;
type CellRef = { row: number; column: number };

const SheetRow = memo(function SheetRow({
  values,
  row,
  columnOffset,
  columnCount,
  selectedColumn,
  cells,
  onSelect,
}: {
  values: readonly string[];
  row: number;
  columnOffset: number;
  columnCount: number;
  selectedColumn: number;
  cells: GridStyles;
  onSelect(cell: CellRef): void;
}) {
  return (
    <View style={{ flexDirection: "row" }}>
      <Text style={[cells.cell, cells.rowNumber]} numberOfLines={1}>
        {row + 1}
      </Text>
      {Array.from({ length: columnCount }, (_, column) => {
        const value = values[column] ?? "";
        return (
          <Text
            key={column}
            style={[cells.cell, cells.value, columnOffset + column === selectedColumn ? cells.selected : null]}
            accessibilityLabel={columnOffset + column === selectedColumn ? `Selected cell ${columnName(selectedColumn)}${row + 1}` : undefined}
            numberOfLines={1}
            ellipsizeMode="tail"
            onPress={() => onSelect({ row, column: columnOffset + column })}
          >
            {value}
          </Text>
        );
      })}
    </View>
  );
});
