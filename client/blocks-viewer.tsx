import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { FlatList } from "@getpaseo/plugin/client/react-native";
import { useInfiniteQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { ActivityIndicator, Image, ScrollView, Text, View } from "react-native";
import { docBlocksRpc, type DocBlock } from "../shared/rpc";
import { fitSize, retryPage } from "./paging";
import { blocksQueryKey } from "./queries";
import { ErrorState, LoadingState, MessageState, type Styles, ToolbarButton } from "./ui";
import { useFitWidth } from "./use-fit-width";

export interface BlocksViewerProps {
  workspaceId: string;
  path: string;
  revision: string;
  theme: PluginTheme;
  styles: Styles;
}

const READING_WIDTH = 720;
const HEADING_SIZE = [22, 20, 18, 16, 15, 14] as const;

export function BlocksViewer({ workspaceId, path, revision, theme, styles }: BlocksViewerProps) {
  const fetchBlocks = useRpc(docBlocksRpc);
  const { contentWidth, onLayout } = useFitWidth(styles.gutter * 2);
  const query = useInfiniteQuery({
    queryKey: blocksQueryKey(workspaceId, path, revision),
    queryFn: ({ pageParam }) => fetchBlocks({ workspaceId, path, cursor: pageParam }),
    initialPageParam: 0,
    retry: retryPage,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    staleTime: Infinity,
  });
  const blocks = useMemo(() => query.data?.pages.flatMap((page) => page.blocks) ?? [], [query.data]);
  const width = Math.min(contentWidth, READING_WIDTH);

  return (
    <View style={styles.screen} onLayout={onLayout}>
      {query.error && !query.data ? (
        <ErrorState theme={theme} styles={styles} error={query.error} onRetry={() => void query.refetch()} />
      ) : !query.data || width === 0 ? (
        <LoadingState theme={theme} styles={styles} />
      ) : blocks.length === 0 ? (
        <MessageState theme={theme} styles={styles} icon="FileType" title="This document is empty" />
      ) : (
        <FlatList
          data={blocks}
          keyExtractor={(_, position) => String(position)}
          contentContainerStyle={{ padding: styles.gutter, paddingBottom: styles.gutter + styles.bottomInset, gap: 12, alignItems: "center" }}
          onEndReachedThreshold={0.5}
          onEndReached={() => {
            if (query.hasNextPage && !query.isFetchingNextPage) void query.fetchNextPage();
          }}
          renderItem={({ item }) => (
            <View style={{ width }}>
              <Block block={item} width={width} theme={theme} styles={styles} />
            </View>
          )}
          ListFooterComponent={
            <View style={{ height: 44, alignItems: "center", justifyContent: "center" }}>
              {query.isFetchingNextPage ? (
                <ActivityIndicator size="small" color={theme.colors.foregroundMuted} />
              ) : query.isFetchNextPageError ? (
                <ToolbarButton theme={theme} styles={styles} label="Try again" onPress={() => void query.fetchNextPage()} />
              ) : query.hasNextPage ? (
                <ToolbarButton theme={theme} styles={styles} label="Load more" onPress={() => void query.fetchNextPage()} />
              ) : null}
            </View>
          }
        />
      )}
    </View>
  );
}

function Block({ block, width, theme, styles }: { block: DocBlock; width: number; theme: PluginTheme; styles: Styles }) {
  switch (block.type) {
    case "heading":
      return (
        <Text
          accessibilityRole="header"
          style={{ color: theme.colors.foreground, fontSize: HEADING_SIZE[block.level - 1], fontWeight: "500", marginTop: 8 }}
          selectable
        >
          {block.text}
        </Text>
      );
    case "paragraph":
      return (
        <Text style={styles.content} selectable>
          {block.text}
        </Text>
      );
    case "list":
      return (
        <View style={{ gap: 4 }}>
          {block.items.map((item, position) => (
            <View key={position} style={{ flexDirection: "row", gap: 8 }}>
              <Text style={[styles.content, { minWidth: 20, color: theme.colors.foregroundMuted }]}>
                {block.ordered ? `${position + 1}.` : "•"}
              </Text>
              <Text style={[styles.content, { flex: 1 }]} selectable>
                {item}
              </Text>
            </View>
          ))}
        </View>
      );
    case "table":
      return (
        <ScrollView horizontal style={styles.card}>
          <View>
            {block.rows.map((row, rowIndex) => (
              <View
                key={rowIndex}
                style={{ flexDirection: "row", borderTopWidth: rowIndex === 0 ? 0 : 1, borderTopColor: theme.colors.border }}
              >
                {row.map((cell, cellIndex) => (
                  <View
                    key={cellIndex}
                    style={{
                      width: 160,
                      padding: 8,
                      borderLeftWidth: cellIndex === 0 ? 0 : 1,
                      borderLeftColor: theme.colors.border,
                    }}
                  >
                    <Text style={styles.text} selectable>
                      {cell}
                    </Text>
                  </View>
                ))}
              </View>
            ))}
          </View>
        </ScrollView>
      );
    case "image": {
      const size = fitSize(Math.min(width, block.image.width), block.image);
      return (
        <Image
          source={{ uri: `data:${block.image.mimeType};base64,${block.image.data}` }}
          style={size}
          resizeMode="contain"
          accessibilityLabel={block.alt || "Image"}
        />
      );
    }
    case "omitted-image":
      return (
        <View style={[styles.card, { padding: 12, gap: 4 }]}>
          <Text style={styles.text}>{block.alt || "Image"}</Text>
          <Text style={styles.muted}>{block.reason}</Text>
        </View>
      );
  }
}
