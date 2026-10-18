import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { tipsDismissRpc, tipsReadRpc } from "../shared/rpc";
import { afterNext, tipControls, TIPS, type TipsChoice, visibleTip } from "./tips";
import { ToolbarButton, type Styles } from "./ui";

const TIPS_QUERY_KEY = ["tips.read"] as const;

// The server's dismissal plus what was pressed in this panel. A failed dismiss is quiet: the tips
// stay closed here and show again next time, which is the only harm.
export function useTips() {
  const read = useRpc(tipsReadRpc);
  const dismiss = useRpc(tipsDismissRpc);
  const queryClient = useQueryClient();
  const server = useQuery({ queryKey: TIPS_QUERY_KEY, queryFn: () => read({}), staleTime: 60_000, retry: false });
  const [choice, setChoice] = useState<TipsChoice>(null);
  const step = visibleTip(server.data?.dismissed, choice);
  const close = () => {
    setChoice("closed");
    queryClient.setQueryData(TIPS_QUERY_KEY, { dismissed: true });
    dismiss({}).catch(() => void queryClient.invalidateQueries({ queryKey: TIPS_QUERY_KEY }));
  };
  return {
    step,
    // Only once the server answered, so a daemon without tips support offers no link.
    canReopen: server.data !== undefined && step === null,
    next() {
      if (step === null) return;
      const after = afterNext(step);
      if (after.dismiss) close();
      else setChoice(after.choice);
    },
    skip: close,
    reopen: () => setChoice({ step: 0 }),
  };
}

export function TipsCard({ theme, styles, step, onNext, onSkip }: { theme: PluginTheme; styles: Styles; step: number; onNext(): void; onSkip(): void }) {
  const tip = TIPS[step]!;
  const controls = tipControls(step);
  return (
    <View accessibilityLabel={`Tip ${controls.progress}`} style={[styles.card, { marginHorizontal: styles.gutter, paddingVertical: 8, paddingHorizontal: 12, gap: 4 }]}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Icon name="Lightbulb" size={14} color={theme.colors.foregroundMuted} />
        <Text style={[styles.text, { flex: 1, fontSize: 13, fontWeight: "600" }]} numberOfLines={1}>
          {tip.title}
        </Text>
        <Text style={styles.label}>{controls.progress}</Text>
      </View>
      <Text style={[styles.muted, { lineHeight: 17 }]}>{tip.text}</Text>
      <View style={{ flexDirection: "row", justifyContent: "flex-end", gap: 8, paddingTop: 4 }}>
        {controls.skip ? <ToolbarButton theme={theme} styles={styles} label="Skip" accessibilityLabel="Skip tips" onPress={onSkip} /> : null}
        <ToolbarButton
          theme={theme}
          styles={styles}
          variant="primary"
          label={controls.next}
          accessibilityLabel={controls.skip ? "Next tip" : "Done with tips"}
          onPress={onNext}
        />
      </View>
    </View>
  );
}

// Brings the tips back after Skip or Done. Small on purpose: it sits under the list for good.
export function TipsLink({ theme, styles, onPress }: { theme: PluginTheme; styles: Styles; onPress(): void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Show tips"
      hitSlop={styles.compact ? 11 : 4}
      onPress={onPress}
      style={({ pressed, hovered }: { pressed: boolean; hovered?: boolean }) => ({
        flexDirection: "row",
        alignItems: "center",
        alignSelf: "flex-start",
        gap: 4,
        height: 22,
        paddingHorizontal: 6,
        borderRadius: 6,
        backgroundColor: pressed || hovered ? theme.colors.surface2 : "transparent",
      })}
    >
      <Icon name="Lightbulb" size={12} color={theme.colors.foregroundMuted} />
      <Text style={styles.muted}>Tips</Text>
    </Pressable>
  );
}
