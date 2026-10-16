import { type PluginOpenScreenInput, type PluginWorkspacePanelProps, useRpc } from "@getpaseo/plugin/client";
import { FlatList, Icon } from "@getpaseo/plugin/client/react-native";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { Pressable, Text, View } from "react-native";
import { docsRecentRpc } from "../shared/rpc";
import { baseName, humanSize, KIND_ICON, KIND_LABEL, parentDir, relativeTime } from "./format";
import { recentQueryOptions } from "./queries";
import { newestFirst } from "../shared/browse";
import { documentScreen } from "./recent";
import { ErrorState, LoadingState, makeStyles, MessageState } from "./ui";

export function createDocumentsPanel(openScreen: (input: PluginOpenScreenInput) => void) {
  return function DocumentsPanel({ theme, layout, workspaceId }: PluginWorkspacePanelProps) {
    const styles = useMemo(() => makeStyles(theme, layout.compact), [theme, layout.compact]);
    const listRecent = useRpc(docsRecentRpc);
    const recent = useQuery({
      ...recentQueryOptions(workspaceId),
      queryFn: () => listRecent({ workspaceId }),
    });
    const entries = useMemo(() => (recent.data ? newestFirst(recent.data.entries) : []), [recent.data]);
    const now = recent.dataUpdatedAt || Date.now();

    if (!recent.data) {
      return (
        <View style={styles.screen}>
          {recent.error ? (
            <ErrorState theme={theme} styles={styles} error={recent.error} onRetry={() => void recent.refetch()} />
          ) : (
            <LoadingState theme={theme} styles={styles} />
          )}
        </View>
      );
    }
    if (entries.length === 0) {
      return (
        <View style={styles.screen}>
          <MessageState
            theme={theme}
            styles={styles}
            icon="Files"
            title="No documents yet"
            detail="PDF, Word, Excel, PowerPoint, image, and video files in this workspace appear here"
          />
        </View>
      );
    }
    return (
      <View style={styles.screen}>
        <FlatList
          data={entries}
          keyExtractor={(entry) => entry.path}
          contentContainerStyle={{ padding: 8 }}
          renderItem={({ item }) => {
            const directory = parentDir(item.path);
            return (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Open ${item.path}, ${KIND_LABEL[item.kind]}, changed ${relativeTime(item.mtimeMs, now)}`}
                onPress={() => openScreen(documentScreen(workspaceId, item.path))}
                style={({ pressed, hovered }: { pressed: boolean; hovered?: boolean }) => ({
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 12,
                  paddingHorizontal: 8,
                  paddingVertical: 8,
                  borderRadius: 8,
                  backgroundColor: pressed || hovered ? theme.colors.surface2 : "transparent",
                })}
              >
                <Icon name={KIND_ICON[item.kind]} size={16} color={theme.colors.foregroundMuted} />
                <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                  <Text style={styles.text} numberOfLines={1}>
                    {baseName(item.path)}
                  </Text>
                  <Text style={styles.muted} numberOfLines={1}>
                    {directory ? `${directory} · ` : ""}
                    {humanSize(item.size)}
                  </Text>
                </View>
                <Text style={styles.label}>{relativeTime(item.mtimeMs, now)}</Text>
              </Pressable>
            );
          }}
          ListFooterComponent={
            recent.data.truncated ? (
              <Text style={[styles.muted, { padding: 8 }]}>Showing the {entries.length} most recently changed</Text>
            ) : null
          }
        />
      </View>
    );
  };
}
