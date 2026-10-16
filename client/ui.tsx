import type { PluginTheme } from "@getpaseo/plugin";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { describeError } from "./format";
import { canRetry } from "./paging";

export function makeStyles(theme: PluginTheme, compact: boolean) {
  const c = theme.colors;
  const gutter = compact ? 12 : 16;
  return {
    gutter,
    screen: { flex: 1, backgroundColor: c.surface0 },
    toolbar: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      gap: 8,
      minHeight: 44,
      paddingHorizontal: gutter,
      paddingVertical: 8,
      borderBottomWidth: 1,
      borderBottomColor: c.border,
      backgroundColor: c.surface0,
    },
    toolbarSpacer: { flex: 1 },
    toolbarGroup: { flexDirection: "row" as const, alignItems: "center" as const, gap: 8 },
    rangeLabel: { minWidth: 132, textAlign: "center" as const },
    text: { color: c.foreground, fontSize: 14 },
    content: { color: c.foreground, fontSize: compact ? 16 : 15, lineHeight: compact ? 24 : 22 },
    muted: { color: c.foregroundMuted, fontSize: 12 },
    label: { color: c.foregroundMuted, fontSize: 12, fontVariant: ["tabular-nums" as const] },
    danger: { color: c.statusDanger, fontSize: 14 },
    centered: {
      flex: 1,
      alignItems: "center" as const,
      justifyContent: "center" as const,
      gap: 8,
      padding: 24,
    },
    stateTitle: { color: c.foreground, fontSize: 14, textAlign: "center" as const },
    stateDetail: { color: c.foregroundMuted, fontSize: 12, textAlign: "center" as const, maxWidth: 420 },
    button: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      justifyContent: "center" as const,
      gap: 4,
      height: 28,
      minWidth: 28,
      paddingHorizontal: 8,
      borderRadius: 6,
      backgroundColor: c.surface2,
    },
    buttonSelected: { backgroundColor: c.accent },
    buttonText: { color: c.foreground, fontSize: 12 },
    buttonTextSelected: { color: c.accentForeground },
    disabled: { opacity: 0.5 },
    card: { borderWidth: 1, borderColor: c.border, borderRadius: 8, backgroundColor: c.surface1 },
  };
}

export type Styles = ReturnType<typeof makeStyles>;

interface ChromeProps {
  theme: PluginTheme;
  styles: Styles;
}

export function LoadingState({ theme, styles, label }: ChromeProps & { label?: string }) {
  return (
    <View style={styles.centered} accessibilityRole="progressbar" accessibilityLabel={label ?? "Loading"}>
      <ActivityIndicator size="large" color={theme.colors.foregroundMuted} />
      {label ? <Text style={styles.stateDetail}>{label}</Text> : null}
    </View>
  );
}

export function MessageState({
  theme,
  styles,
  icon,
  title,
  detail,
  tone = "muted",
  action,
}: ChromeProps & {
  icon: string;
  title: string;
  detail?: string;
  tone?: "muted" | "danger";
  action?: { label: string; onPress(): void };
}) {
  const iconColor = tone === "danger" ? theme.colors.statusDanger : theme.colors.foregroundMuted;
  return (
    <View style={styles.centered} accessibilityRole={tone === "danger" ? "alert" : undefined}>
      <Icon name={icon} size={24} color={iconColor} />
      <Text style={styles.stateTitle}>{title}</Text>
      {detail ? (
        <Text style={styles.stateDetail} selectable>
          {detail}
        </Text>
      ) : null}
      {action ? <ToolbarButton styles={styles} theme={theme} label={action.label} onPress={action.onPress} /> : null}
    </View>
  );
}

export function ErrorState({ theme, styles, error, onRetry }: ChromeProps & { error: unknown; onRetry?: () => void }) {
  const described = describeError(error);
  return (
    <MessageState
      theme={theme}
      styles={styles}
      icon={described.icon}
      title={described.title}
      detail={described.detail}
      tone="danger"
      action={onRetry && canRetry(error) ? { label: "Try again", onPress: onRetry } : undefined}
    />
  );
}

export function ToolbarButton({
  theme,
  styles,
  label,
  icon,
  onPress,
  disabled,
  selected,
  accessibilityLabel,
}: ChromeProps & {
  label?: string;
  icon?: string;
  onPress(): void;
  disabled?: boolean;
  selected?: boolean;
  accessibilityLabel?: string;
}) {
  const color = selected ? theme.colors.accentForeground : theme.colors.foreground;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ disabled: Boolean(disabled), selected: Boolean(selected) }}
      disabled={disabled}
      onPress={onPress}
      style={[styles.button, selected ? styles.buttonSelected : null, disabled ? styles.disabled : null]}
    >
      {icon ? <Icon name={icon} size={14} color={color} /> : null}
      {label ? (
        <Text style={[styles.buttonText, selected ? styles.buttonTextSelected : null]} numberOfLines={1}>
          {label}
        </Text>
      ) : null}
    </Pressable>
  );
}
