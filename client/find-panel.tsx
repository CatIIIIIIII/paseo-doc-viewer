import { useRpc } from "@getpaseo/plugin/client";
import { TextInput } from "@getpaseo/plugin/client/react-native";
import type { PluginTheme } from "@getpaseo/plugin";
import { useEffect, useRef, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { docSearchRpc } from "../shared/rpc";
import type { SearchCursor, SearchMatch, SearchNavigation } from "../shared/search";
import { columnName } from "./paging";
import { ToolbarButton, type Styles } from "./ui";

export function FindPanel({ workspaceId, path, revision, password, theme, styles, onNavigate, onClose, pageLabel = "Page" }: {
  workspaceId: string; path: string; revision: string; password?: string; theme: PluginTheme; styles: Styles;
  onNavigate(value: SearchNavigation): void; onClose(): void; pageLabel?: string;
}) {
  const search = useRpc(docSearchRpc);
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState<SearchMatch[]>([]);
  const [notes, setNotes] = useState<string[]>([]);
  const [next, setNext] = useState<SearchCursor | null>(null);
  const [busy, setBusy] = useState(false);
  const [started, setStarted] = useState(false);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState(-1);
  const generation = useRef(0);
  const navigation = useRef(0);
  const active = useRef(true);
  useEffect(() => { active.current = true; return () => { active.current = false; generation.current++; }; }, []);
  useEffect(() => {
    generation.current++;
    setMatches([]); setNext(null); setNotes([]); setStarted(false); setBusy(false); setError(""); setSelected(-1);
  }, [query, revision]);

  const run = async (cursor: SearchCursor | null) => {
    if (busy || !query.trim()) return;
    const token = ++generation.current;
    setBusy(true); setError(""); setStarted(true);
    if (!cursor) { setMatches([]); setNext(null); setNotes([]); setSelected(-1); }
    let current = cursor;
    const found: SearchMatch[] = [];
    const warnings = new Set<string>();
    try {
      // A bounded burst keeps large searches cancellable without launching an unbounded scan.
      for (let batch = 0; batch < 20; batch++) {
        const result = await search({ workspaceId, path, password, query: query.trim(), cursor: current });
        if (!active.current || token !== generation.current) return;
        if (result.revision !== revision) throw new Error("The document changed. Search again.");
        found.push(...result.matches); result.notes.forEach((note) => warnings.add(note)); current = result.next;
        if (!current || found.length >= 50) break;
      }
      if (token !== generation.current) return;
      setMatches((previous) => cursor ? [...previous, ...found].slice(0, 500) : found);
      setNotes((previous) => [...new Set([...previous, ...warnings])]);
      setNext(current);
      if (!cursor) setSelected(-1);
    } catch (failure) {
      if (active.current && token === generation.current) setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      if (active.current && token === generation.current) setBusy(false);
    }
  };
  const choose = (index: number) => {
    if (!matches[index]) return;
    setSelected(index);
    onNavigate({ target: matches[index].target, query: query.trim(), serial: ++navigation.current });
  };
  return (
    <View style={{ borderBottomWidth: 1, borderBottomColor: theme.colors.border, padding: styles.gutter, gap: 8 }}>
      <View style={[styles.toolbarGroup, { flexWrap: "wrap" }]}>
        <TextInput autoFocus value={query} onChangeText={setQuery} maxLength={200} placeholder="Find in document"
          placeholderTextColor={theme.colors.foregroundMuted} accessibilityLabel="Find in document"
          onSubmitEditing={() => void run(null)} style={[styles.text, { flex: 1, minWidth: 120, padding: 6, backgroundColor: theme.colors.surface1, borderWidth: 1, borderColor: theme.colors.border, borderRadius: 6 }]} />
        <ToolbarButton theme={theme} styles={styles} label="Search" disabled={busy || !query.trim()} onPress={() => void run(null)} />
        {busy ? <ToolbarButton theme={theme} styles={styles} label="Stop" onPress={() => { generation.current++; setBusy(false); setError("Search stopped before completion. Search again to restart."); }} /> : null}
        <ToolbarButton theme={theme} styles={styles} icon="X" accessibilityLabel="Close find" onPress={onClose} />
      </View>
      {started ? <View style={[styles.toolbarGroup, { flexWrap: "wrap" }]}>
        <Text style={styles.label}>{busy ? "Searching…" : `${matches.length}${next || matches.length >= 500 ? "+" : ""} matches${next || error ? " so far" : ""}`}</Text>
        <ToolbarButton theme={theme} styles={styles} icon="ChevronUp" accessibilityLabel="Previous match" disabled={selected <= 0} onPress={() => choose(selected - 1)} />
        <ToolbarButton theme={theme} styles={styles} icon="ChevronDown" accessibilityLabel="Next match" disabled={selected + 1 >= matches.length} onPress={() => choose(selected + 1)} />
        {next && matches.length < 500 ? <ToolbarButton theme={theme} styles={styles} label="Search more" disabled={busy} onPress={() => void run(next)} /> : null}
      </View> : null}
      {error ? <Text style={styles.danger} accessibilityRole="alert">{error}</Text> : null}
      {matches.length >= 500 ? <Text style={styles.muted}>Showing the first 500 results. Narrow your search to find more.</Text> : null}
      {notes.length ? <Text style={styles.muted}>{notes.join(" ")}</Text> : null}
      {matches.length ? <ScrollView style={{ maxHeight: 130 }} keyboardShouldPersistTaps="handled">
        {matches.map((match, index) => {
          const target = match.target;
          const label = target.type === "page" ? `${pageLabel} ${target.index + 1}` : target.type === "block" ? "Text" : `Sheet ${target.sheet + 1}, ${columnName(target.column)}${target.row + 1}`;
          return <View key={index} style={{ paddingVertical: 3 }}><ToolbarButton theme={theme} styles={styles}
            label={`${label}: ${match.snippet.replace(/\s+/g, " ")}`} selected={index === selected} onPress={() => choose(index)} /></View>;
        })}
      </ScrollView> : null}
    </View>
  );
}
