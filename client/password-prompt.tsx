import type { PluginTheme } from "@getpaseo/plugin";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useRef, useState } from "react";
import { ScrollView, Text, TextInput, View } from "react-native";
import { type Styles, ToolbarButton } from "./ui";
import { useKeyboardInset } from "./use-keyboard-inset";

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
  const frame = useRef<View>(null);
  const keyboardInset = useKeyboardInset(frame);
  const submit = () => {
    if (value !== "" && !busy) onSubmit(value);
  };
  return (
    <View ref={frame} style={{ flex: 1, paddingBottom: keyboardInset }}>
      <ScrollView contentContainerStyle={{ ...styles.centered, flex: undefined, flexGrow: 1 }} keyboardShouldPersistTaps="handled">
        <Icon name="Lock" size={24} color={theme.colors.foregroundMuted} />
        <Text style={styles.stateTitle}>This PDF is password protected</Text>
        <Text style={styles.stateDetail}>Enter its password to open it. The password is sent to the daemon to open the file and is not stored.</Text>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8, width: "100%", maxWidth: 360 }}>
          <TextInput
            value={value}
            onChangeText={setValue}
            onSubmitEditing={submit}
            submitBehavior="submit"
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
              paddingVertical: 0,
              borderWidth: 1,
              borderColor: incorrect ? theme.colors.statusDanger : theme.colors.border,
              borderRadius: 8,
              backgroundColor: theme.colors.surface1,
              color: theme.colors.foreground,
              fontSize: compact ? 16 : 14,
            }}
          />
          <ToolbarButton theme={theme} styles={styles} label={busy ? "Unlocking..." : "Unlock"} variant="primary" disabled={busy || value === ""} onPress={submit} />
        </View>
        {incorrect && !busy ? (
          <Text style={styles.danger} accessibilityRole="alert">
            Incorrect password. Try again.
          </Text>
        ) : null}
      </ScrollView>
    </View>
  );
}
