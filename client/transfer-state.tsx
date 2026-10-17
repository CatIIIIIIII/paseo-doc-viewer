import type { PluginTheme } from "@getpaseo/plugin";
import { ActivityIndicator, Text, View } from "react-native";
import { humanSize } from "./format";
import { ToolbarButton, type Styles } from "./ui";

export function TransferState({ theme, styles, title, loaded, size, onCancel, compact = false }: {
  theme: PluginTheme;
  styles: Styles;
  title: string;
  loaded: number;
  size: number;
  onCancel(): void;
  compact?: boolean;
}) {
  const percent = size > 0 ? Math.min(100, Math.round(loaded / size * 100)) : 0;
  return <View style={compact ? { flexDirection: "row", alignItems: "center", padding: styles.gutter, gap: 8 } : styles.centered}>
    <View accessibilityRole="progressbar" accessibilityLabel={title}
      accessibilityValue={size > 0 ? { min: 0, max: 100, now: percent } : undefined}>
      <ActivityIndicator size={compact ? "small" : "large"} color={theme.colors.foregroundMuted} />
    </View>
    <View style={compact ? { flex: 1 } : { alignItems: "center", gap: 8 }}>
      <Text style={compact ? styles.label : styles.stateTitle}>{title}</Text>
      <Text style={styles.stateDetail}>{humanSize(loaded)} of {humanSize(size)}{size > 0 ? ` (${percent}%)` : ""}</Text>
    </View>
    <ToolbarButton theme={theme} styles={styles} label="Cancel loading" onPress={onCancel} />
  </View>;
}
