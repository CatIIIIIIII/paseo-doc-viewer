import type { PluginTheme } from "@getpaseo/plugin";
import { useEffect, useState } from "react";
import { Text, TextInput, View } from "react-native";
import { type Styles, ToolbarButton } from "./ui";

export function PageNavigation({ active, count, theme, styles, onChange }: {
  active: number; count: number; theme: PluginTheme; styles: Styles; onChange(index: number): void;
}) {
  const [draft, setDraft] = useState(String(active + 1));
  useEffect(() => { setDraft(String(active + 1)); }, [active, count]);

  const submit = () => {
    const value = draft.trim();
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) {
      setDraft(String(active + 1));
      return;
    }
    const page = Math.max(1, Math.min(count, Number(value)));
    setDraft(String(page));
    onChange(page - 1);
  };

  return (
    <View style={[styles.toolbarGroup, { gap: 4, flexShrink: 0 }]}>
      <ToolbarButton theme={theme} styles={styles} icon="ChevronLeft" accessibilityLabel="Previous page"
        disabled={active <= 0} onPress={() => onChange(active - 1)} />
      <TextInput
        value={draft}
        onChangeText={setDraft}
        onSubmitEditing={submit}
        onBlur={submit}
        accessibilityLabel="Page number"
        accessibilityHint={`Enter a page from 1 to ${count}`}
        keyboardType="number-pad"
        returnKeyType="done"
        selectTextOnFocus
        maxLength={10}
        style={[styles.text, {
          width: Math.max(34, String(count).length * 9 + 16),
          height: styles.controlSize,
          paddingHorizontal: 4,
          paddingVertical: 0,
          textAlign: "center",
          fontVariant: ["tabular-nums"],
          borderWidth: 1,
          borderColor: theme.colors.border,
          borderRadius: 6,
          backgroundColor: theme.colors.surface1,
        }]}
      />
      <Text style={styles.label} accessibilityLabel={`Total pages: ${count}`}>/ {count}</Text>
      <ToolbarButton theme={theme} styles={styles} icon="ChevronRight" accessibilityLabel="Next page"
        disabled={active >= count - 1} onPress={() => onChange(active + 1)} />
    </View>
  );
}
