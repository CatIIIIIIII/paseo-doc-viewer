import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { copyText, useToast } from "@getpaseo/plugin/client/react-native";
import { useQuery } from "@tanstack/react-query";
import { ActivityIndicator, ScrollView, Text, useWindowDimensions, View } from "react-native";
import { CELL_FULL_MAX_CHARS } from "../shared/limits";
import { docCellRpc, type DocCellOutput } from "../shared/rpc";
import { describeError, formatCount } from "./format";
import { retryPage } from "./paging";
import { ToolbarButton, type Styles } from "./ui";

export interface FullValueTarget {
  sheet: number;
  row: number;
  // null asks for the whole record as JSON.
  column: number | null;
}

export function fullValueQueryKey(workspaceId: string, path: string, revision: string, { sheet, row, column }: FullValueTarget) {
  return ["doc.cell", workspaceId, path, revision, sheet, row, column] as const;
}

export function fullValueSummary(value: Pick<DocCellOutput, "text" | "truncated" | "length" | "format">): string {
  const shown = formatCount(value.text.length);
  if (value.truncated) {
    return value.length !== undefined
      ? `Showing the first ${shown} of ${formatCount(value.length)} characters`
      : `Showing the first ${shown} characters (the limit is ${formatCount(CELL_FULL_MAX_CHARS)})`;
  }
  return `${shown} ${value.text.length === 1 ? "character" : "characters"}${value.format === "json" ? ", indented JSON" : ""}`;
}

// A cell's whole value (or a record's JSON), read only when asked for, wrapped and selectable, with Copy.
export function FullValuePanel({ workspaceId, path, revision, target, title, theme, styles, onClose }: {
  workspaceId: string;
  path: string;
  revision: string;
  target: FullValueTarget;
  title: string;
  theme: PluginTheme;
  styles: Styles;
  onClose(): void;
}) {
  const fetchCell = useRpc(docCellRpc);
  const toast = useToast();
  const viewport = useWindowDimensions();
  const value = useQuery({
    queryKey: fullValueQueryKey(workspaceId, path, revision, target),
    queryFn: () => fetchCell({ workspaceId, path, ...target }),
    retry: retryPage,
    staleTime: Infinity,
  });
  const data = value.data;
  const copy = () => {
    if (!data) return;
    copyText(data.text).then(
      () => toast.show(data.truncated ? "Copied the shown part" : "Copied"),
      () => toast.error("Could not copy the value"),
    );
  };
  return (
    <View style={{ borderTopWidth: 1, borderTopColor: theme.colors.border, paddingTop: 6, gap: 6 }} accessibilityLabel={title}>
      <View style={[styles.toolbarGroup, { flexWrap: "wrap" }]}>
        <Text style={[styles.label, { flex: 1, minWidth: 140 }]}>{data ? `${title} · ${fullValueSummary(data)}` : title}</Text>
        {value.isFetching ? <ActivityIndicator size="small" color={theme.colors.foregroundMuted} /> : null}
        <ToolbarButton theme={theme} styles={styles} icon="Copy" label="Copy" accessibilityLabel={`Copy ${title.toLowerCase()}`} disabled={!data} onPress={copy} />
        <ToolbarButton theme={theme} styles={styles} icon="X" accessibilityLabel={`Close ${title.toLowerCase()}`} onPress={onClose} />
      </View>
      {value.error && !data ? (
        <Text style={styles.danger} accessibilityRole="alert">{describeError(value.error).detail}</Text>
      ) : data ? (
        <ScrollView style={{ maxHeight: Math.max(160, Math.round(viewport.height * 0.4)) }} contentContainerStyle={{ paddingBottom: 4 }} nestedScrollEnabled>
          <Text style={[styles.content, data.format === "json" ? { fontFamily: "monospace", fontSize: 13, lineHeight: 19 } : null]} selectable>
            {data.text || " "}
          </Text>
        </ScrollView>
      ) : null}
    </View>
  );
}
