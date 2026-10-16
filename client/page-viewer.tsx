import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { memo, useEffect, useState } from "react";
import { ActivityIndicator, Image, type ImageStyle, ScrollView, Text, View } from "react-native";
import { docPageRpc, type DocPageOutput } from "../shared/rpc";
import { clampIndex, fitSize, nextZoomStep, omittedImagesNote, pageRequests, previousZoomStep, retryPage, stripItems, zoomLabel } from "./paging";
import { pageQueryKey } from "./queries";
import { ErrorState, LoadingState, type Styles, ToolbarButton } from "./ui";
import { useFitWidth } from "./use-fit-width";
import { usePinchZoom } from "./use-pinch-zoom";

type EncodedImage = Extract<DocPageOutput, { kind: "pdf" }>["image"];

export interface PageViewerProps {
  workspaceId: string;
  path: string;
  revision: string;
  kind: "pdf" | "pptx" | "image";
  count: number;
  theme: PluginTheme;
  styles: Styles;
}

const NOUN = { pdf: "Page", pptx: "Slide", image: "Image" } as const;
const ZOOM_LABEL_WIDTH = 44;

function dataUri(image: EncodedImage): string {
  return `data:${image.mimeType};base64,${image.data}`;
}

export function PageViewer({ workspaceId, path, revision, kind, count, theme, styles }: PageViewerProps) {
  const fetchPage = useRpc(docPageRpc);
  const queryClient = useQueryClient();
  const [index, setIndex] = useState(0);
  const [zoom, setZoom] = useState(1);
  const { contentWidth, requestWidth, onLayout } = useFitWidth(styles.gutter * 2, kind === "pptx" ? 1 : zoom);

  const active = clampIndex(index, count);
  const requests = pageRequests(active, count);

  useEffect(() => {
    if (active !== index) setIndex(active);
  }, [active, index]);

  const pageKey = (target: number) => pageQueryKey(workspaceId, path, revision, target, requestWidth);
  const page = useQuery({
    queryKey: pageKey(active),
    queryFn: () => fetchPage({ workspaceId, path, index: active, maxWidth: requestWidth ?? undefined }),
    enabled: requestWidth !== null && requests.current !== null,
    placeholderData: (previous) => previous,
    staleTime: Infinity,
    retry: retryPage,
  });

  useEffect(() => {
    const next = requests.prefetch;
    if (requestWidth === null || next === null) return;
    void queryClient.prefetchQuery({
      queryKey: pageKey(next),
      queryFn: () => fetchPage({ workspaceId, path, index: next, maxWidth: requestWidth }),
      staleTime: Infinity,
      retry: retryPage,
    });
  }, [queryClient, fetchPage, workspaceId, path, revision, requests.prefetch, requestWidth]);

  const noun = NOUN[kind];
  const paged = count > 1;
  const zoomable = page.data?.kind !== "pptx" || page.data.images.length > 0;
  const { zoomTo, frameProps, outerProps, panProps, bodyProps } = usePinchZoom(zoom, setZoom, zoomable && page.data !== undefined, styles.gutter);

  return (
    <View style={styles.screen}>
      {count > 0 ? (
        <View style={styles.toolbar}>
          {paged ? (
            <>
              <ToolbarButton
                theme={theme}
                styles={styles}
                icon="ChevronLeft"
                accessibilityLabel={`Previous ${noun.toLowerCase()}`}
                disabled={active === 0}
                onPress={() => setIndex(active - 1)}
              />
              <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flex: 1 }} contentContainerStyle={{ gap: 4, alignItems: "center" }}>
                {stripItems(active, count).map((item) =>
                  item.type === "gap" ? (
                    <Text key={`gap-${item.after}`} style={styles.label}>
                      ...
                    </Text>
                  ) : (
                    <ToolbarButton
                      key={item.index}
                      theme={theme}
                      styles={styles}
                      label={String(item.index + 1)}
                      accessibilityLabel={`${noun} ${item.index + 1}`}
                      selected={item.index === active}
                      onPress={() => setIndex(item.index)}
                    />
                  ),
                )}
              </ScrollView>
              <Text style={styles.label}>
                {active + 1} / {count}
              </Text>
              <ToolbarButton
                theme={theme}
                styles={styles}
                icon="ChevronRight"
                accessibilityLabel={`Next ${noun.toLowerCase()}`}
                disabled={active >= count - 1}
                onPress={() => setIndex(active + 1)}
              />
            </>
          ) : (
            <View style={styles.toolbarSpacer} />
          )}
          <View style={{ width: 16, alignItems: "center" }}>
            {page.isFetching ? <ActivityIndicator size="small" color={theme.colors.foregroundMuted} /> : null}
          </View>
          <ToolbarButton
            theme={theme}
            styles={styles}
            icon="ZoomOut"
            accessibilityLabel="Zoom out"
            disabled={!zoomable || zoom === 1}
            onPress={() => zoomTo(previousZoomStep(zoom))}
          />
          <View style={{ width: ZOOM_LABEL_WIDTH }}>
            <ToolbarButton
              theme={theme}
              styles={styles}
              label={zoomLabel(zoom)}
              accessibilityLabel="Fit to width"
              disabled={!zoomable || zoom === 1}
              onPress={() => zoomTo(1)}
            />
          </View>
          <ToolbarButton
            theme={theme}
            styles={styles}
            icon="ZoomIn"
            accessibilityLabel="Zoom in"
            disabled={!zoomable || zoom === nextZoomStep(zoom)}
            onPress={() => zoomTo(nextZoomStep(zoom))}
          />
        </View>
      ) : null}
      <View {...frameProps}>
        <ScrollView {...outerProps} style={{ flex: 1 }} contentContainerStyle={{ padding: styles.gutter, flexGrow: 1 }} onLayout={onLayout}>
          {count === 0 ? (
            <Text style={[styles.muted, { textAlign: "center" }]}>This document has no {noun.toLowerCase()}s</Text>
          ) : page.error && !page.data ? (
            <ErrorState theme={theme} styles={styles} error={page.error} onRetry={() => void page.refetch()} />
          ) : !page.data ? (
            <LoadingState theme={theme} styles={styles} />
          ) : (
            <ScrollView {...panProps} horizontal showsHorizontalScrollIndicator={zoom > 1}>
              <View {...bodyProps}>
                <PageBody page={page.data} contentWidth={contentWidth} zoom={zoom} theme={theme} styles={styles} noun={noun} />
              </View>
            </ScrollView>
          )}
        </ScrollView>
      </View>
    </View>
  );
}

const PageBody = memo(function PageBody({
  page,
  contentWidth,
  zoom,
  theme,
  styles,
  noun,
}: {
  page: DocPageOutput;
  contentWidth: number;
  zoom: number;
  theme: PluginTheme;
  styles: Styles;
  noun: string;
}) {
  const zoomed = (width: number) => Math.round(width * zoom);
  if (page.kind === "pdf") {
    return (
      <FittedImage
        image={page.image}
        width={zoomed(contentWidth)}
        label={`${noun} ${page.index + 1}`}
        style={{ borderWidth: 1, borderColor: theme.colors.border }}
      />
    );
  }
  if (page.kind === "pptx") {
    const omitted = omittedImagesNote(page.omittedImages);
    const widths = page.images.map((image) => zoomed(Math.min(contentWidth, image.width)));
    return (
      <View style={{ gap: 16, width: Math.max(contentWidth, ...widths) }}>
        {page.texts.length === 0 && page.images.length === 0 ? (
          <Text style={styles.muted}>This slide has no text or images</Text>
        ) : null}
        {page.texts.map((text, position) => (
          <Text
            key={`text-${position}`}
            style={[styles.content, { maxWidth: contentWidth }, position === 0 ? { fontWeight: "500" } : null]}
            selectable
          >
            {text}
          </Text>
        ))}
        {page.images.map((image, position) => (
          <FittedImage
            key={`image-${position}`}
            image={image}
            width={widths[position]!}
            label={`Slide ${page.index + 1} image ${position + 1}`}
          />
        ))}
        {omitted ? <Text style={styles.muted}>{omitted}</Text> : null}
      </View>
    );
  }
  const width = zoomed(Math.min(contentWidth, page.sourceWidth));
  return (
    <View style={{ alignItems: "center", gap: 8, width: Math.max(contentWidth, width) }}>
      <FittedImage image={page.image} width={width} label="Image" />
      <Text style={[styles.label, { color: theme.colors.foregroundMuted }]}>
        {page.sourceWidth} x {page.sourceHeight}
      </Text>
    </View>
  );
});

function FittedImage({ image, width, label, style }: { image: EncodedImage; width: number; label: string; style?: ImageStyle }) {
  const size = fitSize(width, image);
  if (size.width === 0) return null;
  return <Image source={{ uri: dataUri(image) }} style={[size, style]} resizeMode="contain" accessibilityLabel={label} />;
}
