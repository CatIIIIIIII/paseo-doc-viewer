import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, ScrollView, Text, View } from "react-native";
import { docIssuesRpc, type DocIssuesOutput } from "../shared/rpc";
import { formatCount } from "./format";
import { coverageText, issueLabel, issueSummary, mergeInspected, pausedText, type InspectedRange, type SheetIssue } from "./issues";
import { ToolbarButton, type Styles } from "./ui";

const MAX_LISTED = 1_000;

export function IssuesPanel({ workspaceId, path, revision, sheetNames, theme, styles, onJump, onClose }: {
  workspaceId: string;
  path: string;
  revision: string;
  sheetNames: readonly string[];
  theme: PluginTheme;
  styles: Styles;
  onJump(target: { sheet: number; row: number; column: number }): void;
  onClose(): void;
}) {
  const check = useRpc(docIssuesRpc);
  const [issues, setIssues] = useState<SheetIssue[]>([]);
  const [inspected, setInspected] = useState<InspectedRange[]>([]);
  const [page, setPage] = useState<Pick<DocIssuesOutput, "next" | "stopped"> | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [chosen, setChosen] = useState(-1);
  const [collapsed, setCollapsed] = useState(false);
  const active = useRef(true);
  useEffect(() => () => { active.current = false; }, []);

  const run = async (cursor: DocIssuesOutput["next"]) => {
    setBusy(true);
    setError("");
    try {
      const result = await check({ workspaceId, path, cursor });
      if (!active.current) return;
      if (result.revision !== revision) throw new Error("The workbook changed. Check again.");
      setIssues((previous) => [...previous, ...result.issues].slice(0, MAX_LISTED));
      setInspected((previous) => mergeInspected(previous, result.inspected));
      setPage({ next: result.next, stopped: result.stopped });
    } catch (failure) {
      if (active.current) setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      if (active.current) setBusy(false);
    }
  };
  useEffect(() => { void run(null); }, []);

  const full = issues.length >= MAX_LISTED;
  const choose = (index: number) => {
    const issue = issues[index];
    if (!issue) return;
    setChosen(index);
    setCollapsed(true);
    onJump(issue);
  };
  // After a jump the list folds to one line, so the inspector and grid keep the screen on a phone.
  if (collapsed && issues[chosen]) {
    return (
      <View style={[styles.toolbar, { flexWrap: "wrap" }]} accessibilityLabel="Sheet issues">
        <Text style={[styles.label, { flex: 1, minWidth: 120 }]}>Issue {formatCount(chosen + 1)} of {formatCount(issues.length)}{page?.next ? "+" : ""}</Text>
        <ToolbarButton theme={theme} styles={styles} icon="ChevronUp" accessibilityLabel="Previous issue" disabled={chosen <= 0} onPress={() => choose(chosen - 1)} />
        <ToolbarButton theme={theme} styles={styles} icon="ChevronDown" accessibilityLabel="Next issue" disabled={chosen + 1 >= issues.length} onPress={() => choose(chosen + 1)} />
        <ToolbarButton theme={theme} styles={styles} label="Show list" onPress={() => setCollapsed(false)} />
        <ToolbarButton theme={theme} styles={styles} icon="X" accessibilityLabel="Close issues" onPress={onClose} />
      </View>
    );
  }
  return (
    <View style={{ borderBottomWidth: 1, borderBottomColor: theme.colors.border, padding: styles.gutter, gap: 6 }} accessibilityLabel="Sheet issues">
      <View style={[styles.toolbarGroup, { flexWrap: "wrap" }]}>
        <Text style={[styles.text, { flex: 1, minWidth: 160 }]}>{page ? issueSummary(issues) : "Checking for error cells and formulas without a saved result…"}</Text>
        {busy ? <ActivityIndicator size="small" color={theme.colors.foregroundMuted} /> : null}
        {page?.next && !busy && !full ? <ToolbarButton theme={theme} styles={styles} label="Continue check" onPress={() => void run(page.next)} /> : null}
        <ToolbarButton theme={theme} styles={styles} icon="X" accessibilityLabel="Close issues" onPress={onClose} />
      </View>
      {page ? <Text style={styles.muted}>{coverageText(inspected, sheetNames)}{page.next && page.stopped ? ` ${pausedText(page.stopped, page.next, sheetNames)}` : ""}</Text> : null}
      {full && page?.next ? <Text style={styles.muted}>Showing the first {formatCount(MAX_LISTED)} issues.</Text> : null}
      {error ? <Text style={styles.danger} accessibilityRole="alert">{error}</Text> : null}
      <Text style={styles.muted}>Nothing is recalculated, and saved results can be stale. A missing saved result is not necessarily a mistake.</Text>
      {issues.length ? (
        <ScrollView style={{ maxHeight: 150 }}>
          {issues.map((issue, index) => (
            <View key={`${issue.sheet}:${issue.row}:${issue.column}`} style={{ paddingVertical: 3, alignItems: "flex-start" }}>
              <ToolbarButton theme={theme} styles={styles} label={issueLabel(issue, sheetNames)} selected={index === chosen}
                onPress={() => choose(index)} />
            </View>
          ))}
        </ScrollView>
      ) : null}
    </View>
  );
}
