import type { PluginTheme } from "@getpaseo/plugin";
import { Text } from "react-native";
import { literalPattern } from "../shared/search";

// Marks every match; the match starting at `active` is the selected search result.
export function Highlight({ text, query, theme, active }: { text: string; query?: string; theme: PluginTheme; active?: number }) {
  if (!query) return <>{text}</>;
  const pattern = literalPattern(query);
  const parts = [];
  let offset = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) && parts.length < 1000) {
    parts.push(text.slice(offset, match.index));
    const current = match.index === active;
    parts.push(
      <Text key={match.index} accessibilityLabel={current ? `Current match: ${match[0]}` : undefined}
        style={current ? { backgroundColor: theme.colors.accent, color: theme.colors.accentForeground } : { backgroundColor: theme.colors.surface2 }}>
        {match[0]}
      </Text>,
    );
    offset = pattern.lastIndex;
  }
  parts.push(text.slice(offset));
  return <>{parts}</>;
}

// Search matches text joined with one-character separators; maps an offset in the
// joined text to the part it falls in.
export function activeInPart(parts: readonly string[], index: number, active: number | undefined): number | undefined {
  if (active === undefined) return undefined;
  let base = 0;
  for (let part = 0; part < index; part++) base += parts[part]!.length + 1;
  const local = active - base;
  return local >= 0 && local < parts[index]!.length ? local : undefined;
}
