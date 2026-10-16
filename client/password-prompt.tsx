import type { PluginTheme } from "@getpaseo/plugin";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useState } from "react";
import { Text, TextInput, View } from "react-native";
import { type Styles, ToolbarButton } from "./ui";

export interface PasswordPromptProps {
  theme: PluginTheme;
  styles: Styles;
  compact: boolean;
  incorrect: boolean;
  busy: boolean;
  onSubmit(password: string): void;
}

export function PasswordPrompt({ theme, styles, compact, incorrect, busy, onSubmit }: PasswordPromptProps) {
  const [value, setValue] = useState("");
  const submit = () => {
    if (value !== "" && !busy) onSubmit(value);
  };
  return (
    <View style={styles.centered}>
      <Icon name="Lock" size={24} color={theme.colors.foregroundMuted} />
      <Text style={styles.stateTitle}>This PDF is password protected</Text>
      <Text style={styles.stateDetail}>Enter its password to open it. The password is sent to the daemon to open the file and is not stored.</Text>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8, width: "100%", maxWidth: 360 }}>
        <TextInput
          value={value}
          onChangeText={setValue}
          onSubmitEditing={submit}
          secureTextEntry
          autoComplete="off"
          autoCapitalize="none"
          autoCorrect={false}
          autoFocus
          returnKeyType="go"
          placeholder="Password"
          placeholderTextColor={theme.colors.foregroundMuted}
          accessibilityLabel="PDF password"
          style={{
            flex: 1,
            minWidth: 0,
            height: 36,
            paddingHorizontal: 10,
            borderWidth: 1,
            borderColor: incorrect ? theme.colors.statusDanger : theme.colors.border,
            borderRadius: 8,
            backgroundColor: theme.colors.surface1,
            color: theme.colors.foreground,
            fontSize: compact ? 16 : 14,
          }}
        />
        <ToolbarButton theme={theme} styles={styles} label={busy ? "Unlocking..." : "Unlock"} disabled={busy || value === ""} onPress={submit} />
      </View>
      {incorrect && !busy ? (
        <Text style={styles.danger} accessibilityRole="alert">
          Incorrect password. Try again.
        </Text>
      ) : null}
    </View>
  );
}
