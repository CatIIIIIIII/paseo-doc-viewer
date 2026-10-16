import { type PluginScreenProps, useRpc } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { View } from "react-native";
import { docOpenRpc, type DocOpenOutput } from "../shared/rpc";
import { BlocksViewer } from "./blocks-viewer";
import { baseName } from "./format";
import { PageViewer } from "./page-viewer";
import { documentQueryOptions } from "./queries";
import { SheetViewer } from "./sheet-viewer";
import { ErrorState, LoadingState, makeStyles, MessageState, type Styles } from "./ui";
import { VideoViewer } from "./video-viewer";

export function documentTitle(params: Record<string, string>): string {
  return params.path ? baseName(params.path) : "Document";
}

export function DocumentScreen({ theme, layout, params }: PluginScreenProps) {
  const styles = useMemo(() => makeStyles(theme, layout.compact), [theme, layout.compact]);
  const workspaceId = params.workspaceId ?? "";
  const path = params.path ?? "";
  const openDocument = useRpc(docOpenRpc);
  const opened = useQuery({
    ...documentQueryOptions(workspaceId, path),
    queryFn: () => openDocument({ workspaceId, path }),
    retry: false,
  });

  if (!workspaceId || !path) {
    return (
      <View style={styles.screen}>
        <MessageState theme={theme} styles={styles} icon="FileX" title="No document selected" />
      </View>
    );
  }
  if (!opened.data) {
    return (
      <View style={styles.screen}>
        {opened.error ? (
          <ErrorState theme={theme} styles={styles} error={opened.error} onRetry={() => void opened.refetch()} />
        ) : (
          <LoadingState theme={theme} styles={styles} />
        )}
      </View>
    );
  }
  return <DocumentBody document={opened.data} workspaceId={workspaceId} path={path} theme={theme} styles={styles} />;
}

function DocumentBody({
  document,
  workspaceId,
  path,
  theme,
  styles,
}: {
  document: DocOpenOutput;
  workspaceId: string;
  path: string;
  theme: PluginScreenProps["theme"];
  styles: Styles;
}) {
  const common = { workspaceId, path, revision: document.revision, theme, styles };
  const key = `${workspaceId}\0${path}`;
  switch (document.kind) {
    case "pdf":
      return <PageViewer key={key} {...common} kind="pdf" count={document.pageCount} />;
    case "pptx":
      return <PageViewer key={key} {...common} kind="pptx" count={document.slideCount} />;
    case "image-raster":
    case "image-decoded":
      return <PageViewer key={key} {...common} kind="image" count={1} />;
    case "docx":
      return <BlocksViewer {...common} />;
    case "xlsx":
      return <SheetViewer {...common} sheets={document.sheets} />;
    case "video":
      return <VideoViewer {...common} mimeType={document.mimeType} size={document.size} />;
  }
}
