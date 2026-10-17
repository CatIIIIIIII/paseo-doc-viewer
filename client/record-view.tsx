import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import { type ReactNode, useEffect, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, Text, View } from "react-native";
import { XLSX_MAX_COLUMNS } from "../shared/limits";
import { docRowsRpc } from "../shared/rpc";
import { CellInspector } from "./cell-inspector";
import { columnName, rangeLabel, retryPage } from "./paging";
import { rowsQueryKey } from "./queries";
import { clampRecord, firstRecord, headerPreview, recordFields, recordLabel } from "./records";
import { ErrorState, LoadingState, MessageState, ToolbarButton, type Styles } from "./ui";

const CHOOSER_ROWS = 20;

interface RecordSheet {
  index: number;
  name: string;
  rowCount: number;
  columnCount: number;
  countsApproximate?: boolean;
}

interface Common {
  leading?: ReactNode;
  workspaceId: string;
  path: string;
  revision: string;
  sheet: RecordSheet;
  theme: PluginTheme;
  styles: Styles;
}

function useRow(common: Common, row: number, columnOffset: number, maxRows: number, enabled = true) {
  const fetchRows = useRpc(docRowsRpc);
  const { workspaceId, path, revision, sheet } = common;
  return useQuery({
    queryKey: [...rowsQueryKey(workspaceId, path, revision, { sheet: sheet.index, rowOffset: row, columnOffset }, XLSX_MAX_COLUMNS), maxRows] as const,
    queryFn: () => fetchRows({ workspaceId, path, sheet: sheet.index, rowOffset: row, columnOffset, maxRows, maxColumns: XLSX_MAX_COLUMNS }),
    enabled,
    retry: retryPage,
    staleTime: Infinity,
  });
}

// The header row is always the user's choice: title rows, merged headers and notes above a table are common.
export function HeaderChooser({ onChoose, leading, ...common }: Common & { onChoose(header: number | null): void }) {
  const { theme, styles } = common;
  const [offset, setOffset] = useState(0);
  const rows = useRow(common, offset, 0, CHOOSER_ROWS);
  const data = rows.data;
  return (
    <View style={{ flex: 1 }}>
      <View style={[styles.toolbar, { flexWrap: "wrap" }]}>
        {leading}
        <Text style={[styles.text, { flexShrink: 1 }]}>Choose the header row</Text>
        <View style={styles.toolbarSpacer} />
        <ToolbarButton theme={theme} styles={styles} label="No header row" onPress={() => onChoose(null)} />
      </View>
      {rows.error && !data ? (
        <ErrorState theme={theme} styles={styles} error={rows.error} onRetry={() => void rows.refetch()} />
      ) : !data ? (
        <LoadingState theme={theme} styles={styles} />
      ) : data.rows.length === 0 ? (
        <MessageState theme={theme} styles={styles} icon="FileSpreadsheet" title="This sheet is empty" />
      ) : (
        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: styles.gutter, gap: 6, paddingBottom: styles.bottomInset + styles.gutter }}>
          {data.rows.map((values, index) => (
            <Pressable key={offset + index} accessibilityRole="button" accessibilityLabel={`Use row ${offset + index + 1} as header`}
              onPress={() => onChoose(offset + index)} style={[styles.card, { flexDirection: "row", gap: 12, padding: 10 }]}>
              <Text style={[styles.label, { width: 48 }]}>Row {offset + index + 1}</Text>
              <Text style={[styles.text, { flex: 1 }]} numberOfLines={1}>{headerPreview(values)}</Text>
            </Pressable>
          ))}
          <View style={[styles.toolbarGroup, { justifyContent: "center" }]}>
            <ToolbarButton theme={theme} styles={styles} icon="ChevronUp" label="Earlier rows" disabled={offset === 0}
              onPress={() => setOffset(Math.max(0, offset - CHOOSER_ROWS))} />
            <ToolbarButton theme={theme} styles={styles} icon="ChevronDown" label="Later rows" disabled={data.nextRowOffset === null}
              onPress={() => setOffset(data.nextRowOffset ?? offset)} />
          </View>
        </ScrollView>
      )}
    </View>
  );
}

export function RecordCard({ header, initialRow, onChangeHeader, onShowInGrid, leading, ...common }: Common & {
  header: number | null;
  initialRow: number;
  onChangeHeader(): void;
  onShowInGrid(row: number): void;
}) {
  const { workspaceId, path, revision, sheet, theme, styles } = common;
  const [row, setRow] = useState(() => clampRecord(initialRow, header, Math.max(sheet.rowCount, initialRow + 1)));
  const [fieldOffset, setFieldOffset] = useState(0);
  const [inspected, setInspected] = useState<number | null>(null);
  useEffect(() => setInspected(null), [row, fieldOffset]);
  const headerRow = useRow(common, header ?? 0, fieldOffset, 1, header !== null);
  const record = useRow(common, row, fieldOffset, 1);
  const data = record.data;
  const rowCount = data?.rowCount ?? sheet.rowCount;
  const approximate = data?.countsApproximate ?? sheet.countsApproximate ?? false;
  const columnCount = data?.columnCount ?? sheet.columnCount;
  const values = data?.rows[0];
  const shown = values ? Math.min(values.length, columnCount - fieldOffset) : 0;
  const card = values && (header === null || headerRow.data) ? recordFields(header === null ? null : (headerRow.data?.rows[0] ?? []), values, fieldOffset) : null;
  const field = card?.fields.find((candidate) => candidate.column === inspected);
  return (
    <View style={{ flex: 1 }}>
      <View style={[styles.toolbar, { flexWrap: "wrap" }]}>
        {leading}
        <ToolbarButton theme={theme} styles={styles} label={header === null ? "No header row" : `Header: row ${header + 1}`}
          accessibilityLabel="Change header row" onPress={onChangeHeader} />
        <View style={styles.toolbarSpacer} />
        <View style={styles.toolbarGroup}>
          <ToolbarButton theme={theme} styles={styles} icon="ChevronLeft" accessibilityLabel="Previous record"
            disabled={row <= firstRecord(header)} onPress={() => setRow(row - 1)} />
          <Text style={[styles.label, styles.rangeLabel]}>{recordLabel(row, header, Math.max(rowCount, row + 1), approximate)}</Text>
          <ToolbarButton theme={theme} styles={styles} icon="ChevronRight" accessibilityLabel="Next record"
            disabled={!data || data.nextRowOffset === null} onPress={() => setRow(row + 1)} />
        </View>
        <ToolbarButton theme={theme} styles={styles} label="Show in grid" onPress={() => onShowInGrid(row)} />
      </View>
      {columnCount > XLSX_MAX_COLUMNS ? (
        <View style={styles.toolbar}>
          <ToolbarButton theme={theme} styles={styles} icon="ChevronLeft" accessibilityLabel="Previous fields" disabled={fieldOffset === 0}
            onPress={() => setFieldOffset(Math.max(0, fieldOffset - XLSX_MAX_COLUMNS))} />
          <Text style={[styles.label, styles.rangeLabel]}>{rangeLabel("columns", fieldOffset, shown, columnCount, { approximate, more: data?.nextColumnOffset != null })}</Text>
          <ToolbarButton theme={theme} styles={styles} icon="ChevronRight" accessibilityLabel="Next fields" disabled={!data || data.nextColumnOffset === null}
            onPress={() => setFieldOffset(data?.nextColumnOffset ?? fieldOffset)} />
          <View style={{ width: 16 }}>{record.isFetching ? <ActivityIndicator size="small" color={theme.colors.foregroundMuted} /> : null}</View>
        </View>
      ) : null}
      {field ? (
        <CellInspector workspaceId={workspaceId} path={path} revision={revision} sheetName={sheet.name}
          target={{ sheet: sheet.index, row, column: field.column }} shown={field.value} theme={theme} styles={styles} onClose={() => setInspected(null)} />
      ) : null}
      {record.error && !data ? (
        <ErrorState theme={theme} styles={styles} error={record.error} onRetry={() => void record.refetch()} />
      ) : headerRow.error && !headerRow.data ? (
        <ErrorState theme={theme} styles={styles} error={headerRow.error} onRetry={() => void headerRow.refetch()} />
      ) : !card ? (
        <LoadingState theme={theme} styles={styles} />
      ) : card.fields.length === 0 ? (
        <MessageState theme={theme} styles={styles} icon="FileSpreadsheet" title={`Row ${row + 1} is empty in these columns`} />
      ) : (
        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: styles.gutter, paddingBottom: styles.bottomInset + styles.gutter }}>
          <View style={[styles.card, { paddingVertical: 4 }]} accessibilityLabel={`Record row ${row + 1}`}>
            {card.fields.map((entry, index) => (
              <Pressable key={entry.column} accessibilityRole="button" accessibilityLabel={`Inspect ${entry.label}`} onPress={() => setInspected(entry.column)}
                style={{ paddingHorizontal: 12, paddingVertical: 8, gap: 2, borderTopWidth: index === 0 ? 0 : 1, borderTopColor: theme.colors.border,
                  backgroundColor: entry.column === inspected ? theme.colors.surface2 : undefined }}>
                <Text style={styles.label}>{entry.label === columnName(entry.column) ? entry.label : `${entry.label} · ${columnName(entry.column)}`}</Text>
                <Text style={styles.content} selectable>{entry.value}</Text>
              </Pressable>
            ))}
          </View>
          {card.hiddenEmpty > 0 ? (
            <Text style={[styles.muted, { paddingTop: 8 }]}>{card.hiddenEmpty === 1 ? "1 empty field hidden" : `${card.hiddenEmpty} empty fields hidden`}</Text>
          ) : null}
        </ScrollView>
      )}
    </View>
  );
}
