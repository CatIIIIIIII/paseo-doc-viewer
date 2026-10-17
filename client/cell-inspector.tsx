import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useQuery } from "@tanstack/react-query";
import { type ReactNode, useEffect, useState } from "react";
import { ActivityIndicator, ScrollView, Text, View } from "react-native";
import { docRowsRpc } from "../shared/rpc";
import { cellReference, hasFullValue, inspectorFields } from "./cell-detail";
import { FullValuePanel } from "./full-value";
import { describeError } from "./format";
import { retryPage } from "./paging";
import { cellQueryKey } from "./queries";
import { ToolbarButton, type Styles } from "./ui";

export interface CellTarget {
  sheet: number;
  row: number;
  column: number;
}

export function CellInspector({ workspaceId, path, revision, sheetName, columnLabel, target, shown, theme, styles, onClose, actions }: {
  workspaceId: string;
  path: string;
  revision: string;
  sheetName: string;
  // Files with named columns (JSON Lines, Parquet) refer to a cell by column name and row.
  columnLabel?: string;
  target: CellTarget;
  shown: ReactNode;
  theme: PluginTheme;
  styles: Styles;
  onClose(): void;
  actions?: ReactNode;
}) {
  const fetchRows = useRpc(docRowsRpc);
  const detail = useQuery({
    queryKey: cellQueryKey(workspaceId, path, revision, target),
    queryFn: () => fetchRows({ workspaceId, path, sheet: target.sheet, rowOffset: target.row, columnOffset: target.column, maxRows: 1, maxColumns: 1, detail: true }),
    retry: retryPage,
    staleTime: Infinity,
  });
  const data = detail.data;
  const [showFull, setShowFull] = useState(false);
  useEffect(() => setShowFull(false), [revision, target.sheet, target.row, target.column]);
  const reference = columnLabel !== undefined ? `${columnLabel}, row ${target.row + 1}` : cellReference(data?.kind === "csv" ? null : sheetName, target.row, target.column);
  const stored = data?.details?.[0]?.[0] ?? null;
  const fields = data ? inspectorFields(stored) : [];
  return (
    <View style={{ borderBottomWidth: 1, borderBottomColor: theme.colors.border, paddingHorizontal: styles.gutter, paddingVertical: 8, gap: 6 }}
      accessibilityLabel={`Cell ${reference}`}>
      <View style={[styles.toolbarGroup, { alignItems: "flex-start" }]}>
        <Text style={[styles.label, { paddingVertical: 6 }]} selectable>{reference}</Text>
        <ScrollView style={{ flex: 1, maxHeight: 72 }} contentContainerStyle={{ paddingVertical: 4 }}>
          <Text style={styles.text} selectable>{shown}</Text>
        </ScrollView>
        {actions}
        <ToolbarButton theme={theme} styles={styles} icon="X" accessibilityLabel="Close cell" onPress={onClose} />
      </View>
      {detail.error && !data ? (
        <Text style={styles.danger} accessibilityRole="alert">{describeError(detail.error).title}</Text>
      ) : !data ? (
        <ActivityIndicator size="small" color={theme.colors.foregroundMuted} />
      ) : (
        <ScrollView style={{ maxHeight: 168 }}>
          {fields.map((field) => (
            <View key={field.label} style={{ flexDirection: "row", gap: 8, paddingVertical: 2 }}>
              <Text style={[styles.label, { width: 104, paddingTop: 1 }]}>{field.label}</Text>
              <View style={{ flex: 1, gap: 2 }}>
                <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
                  {field.tone === "info" ? <Icon name="Info" size={14} color={theme.colors.foregroundMuted} /> : null}
                  <Text style={[styles.text, { flexShrink: 1 }]} selectable>{field.value}</Text>
                </View>
                {field.note ? <Text style={styles.muted}>{field.note}</Text> : null}
              </View>
            </View>
          ))}
        </ScrollView>
      )}
      {data && hasFullValue(stored) ? (
        showFull ? (
          <FullValuePanel workspaceId={workspaceId} path={path} revision={revision} target={target} title="Full value" theme={theme} styles={styles}
            onClose={() => setShowFull(false)} />
        ) : (
          <View style={styles.toolbarGroup}>
            <ToolbarButton theme={theme} styles={styles} icon="WrapText" label="Show full value" onPress={() => setShowFull(true)} />
          </View>
        )
      ) : null}
    </View>
  );
}
