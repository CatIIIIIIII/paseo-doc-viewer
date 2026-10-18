import { useSettings, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { SettingsAction, SettingsCard, SettingsSection, SettingsSwitch } from "@getpaseo/plugin/client/ui";
import { Text } from "react-native";
import { viewerSettings } from "../shared/settings";

export const SETTINGS_SCREEN_ID = "viewer";

export function ViewerSettings({ theme }: PluginSurfaceProps) {
  const settings = useSettings(viewerSettings);
  const muted = { color: theme.colors.foregroundMuted, fontSize: 13 };
  if (settings.status === "loading") return <Text style={muted}>Loading settings…</Text>;
  if (settings.status !== "ready") {
    return (
      <SettingsSection title="Agent turns">
        <Text style={muted}>{settings.error}</Text>
        <SettingsAction label="Try again" actionLabel="Reload" onPress={settings.reload} />
        {settings.status === "invalid" ? <SettingsAction label="Restore default settings" actionLabel="Reset" onPress={settings.reset} /> : null}
      </SettingsSection>
    );
  }
  return (
    <SettingsSection title="Agent turns">
      <SettingsCard>
        <SettingsSwitch
          label="Show changed documents after each turn"
          hint="A timeline card lists the documents whose modified time falls inside the turn, whoever changed them."
          value={settings.values.turnCards}
          disabled={settings.saving}
          onValueChange={(turnCards: boolean) => void settings.save({ ...settings.values, turnCards }, settings.revision)}
        />
      </SettingsCard>
    </SettingsSection>
  );
}
