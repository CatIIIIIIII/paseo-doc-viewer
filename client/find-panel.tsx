import { useRpc } from "@getpaseo/plugin/client";
import { TextInput } from "@getpaseo/plugin/client/react-native";
import type { PluginTheme } from "@getpaseo/plugin";
import { useEffect, useRef, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { docSearchRpc } from "../shared/rpc";
import type { SearchCursor, SearchMatch, SearchNavigation } from "../shared/search";
import { columnName } from "./paging";
import { ToolbarButton, type Styles } from "./ui";

const MAX_RESULTS = 500;

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
  const [session] = useState(() => Math.random().toString(36).slice(2, 12));
  const navigation = useRef(0);
  const active = useRef(true);
  useEffect(() => { active.current = true; return () => { active.current = false; generation.current++; }; }, []);
  useEffect(() => {
    generation.current++;
    setMatches([]); setNext(null); setNotes([]); setStarted(false); setBusy(false); setError(""); setSelected(-1);
  }, [query, revision]);

  // Keeps requesting while the panel is open; each request is bounded by the server's time budget.
  const run = async () => {
    if (!query.trim()) return;
    const token = ++generation.current;
    setBusy(true); setError(""); setStarted(true); setMatches([]); setNext(null); setNotes([]); setSelected(-1);
    let cursor: SearchCursor | null = null;
    let total = 0;
    try {
      do {
        const result = await search({ workspaceId, path, password, query: query.trim(), cursor, searchId: { session, generation: token } });
        if (!active.current || token !== generation.current) return;
        if (result.revision !== revision) throw new Error("The document changed. Search again.");
        cursor = result.next;
        total += result.matches.length;
        setMatches((previous) => [...previous, ...result.matches].slice(0, MAX_RESULTS));
        setNotes((previous) => [...new Set([...previous, ...result.notes])]);
        setNext(cursor);
      } while (cursor && total < MAX_RESULTS);
    } catch (failure) {
      if (active.current && token === generation.current) setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      if (active.current && token === generation.current) setBusy(false);
    }
  };
  const choose = (index: number) => {
    if (!matches[index]) return;
    setSelected(index);
    onNavigate({ target: matches[index].target, query: query.trim(), start: matches[index].start, serial: ++navigation.current });
  };
  return (
    <View style={{ borderBottomWidth: 1, borderBottomColor: theme.colors.border, padding: styles.gutter, gap: 8 }}>
      <View style={[styles.toolbarGroup, { flexWrap: "wrap" }]}>
        <TextInput autoFocus value={query} onChangeText={setQuery} maxLength={200} placeholder="Find in document"
          placeholderTextColor={theme.colors.foregroundMuted} accessibilityLabel="Find in document"
          onSubmitEditing={() => void run()} style={[styles.text, { flex: 1, minWidth: 120, padding: 6, backgroundColor: theme.colors.surface1, borderWidth: 1, borderColor: theme.colors.border, borderRadius: 6 }]} />
        <ToolbarButton theme={theme} styles={styles} label="Search" disabled={busy || !query.trim()} onPress={() => void run()} />
        {busy ? <ToolbarButton theme={theme} styles={styles} label="Stop" onPress={() => { generation.current++; setBusy(false); setError("Search stopped before completion. Search again to restart."); }} /> : null}
        <ToolbarButton theme={theme} styles={styles} icon="X" accessibilityLabel="Close find" onPress={onClose} />
      </View>
      {started ? <View style={[styles.toolbarGroup, { flexWrap: "wrap" }]}>
        <Text style={styles.label}>{busy ? `Searching… ${matches.length} so far` : `${matches.length}${next ? "+" : ""} ${matches.length === 1 && !next ? "match" : "matches"}${next || error ? " so far" : ""}`}</Text>
        <ToolbarButton theme={theme} styles={styles} icon="ChevronUp" accessibilityLabel="Previous match" disabled={selected <= 0} onPress={() => choose(selected - 1)} />
        <ToolbarButton theme={theme} styles={styles} icon="ChevronDown" accessibilityLabel="Next match" disabled={selected + 1 >= matches.length} onPress={() => choose(selected + 1)} />
      </View> : null}
      {error ? <Text style={styles.danger} accessibilityRole="alert">{error}</Text> : null}
      {next && !busy && matches.length >= MAX_RESULTS ? <Text style={styles.muted}>Showing the first {MAX_RESULTS} results. Narrow your search to find more.</Text> : null}
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
