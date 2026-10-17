import type { SearchNavigation } from "../shared/search";
import { FindPanel } from "./find-panel";
import { canDownloadOriginal, FindScope } from "./web";
import { DownloadOriginal } from "./download-original";
import { type PluginScreenProps, useRpc } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { View } from "react-native";
import { docOpenRpc, type DocOpenOutput } from "../shared/rpc";
import { BlocksViewer } from "./blocks-viewer";
import { baseName } from "./format";
import { PageViewer } from "./page-viewer";
import { passwordPrompt } from "./password";
import { PasswordPrompt } from "./password-prompt";
import { documentQueryOptions } from "./queries";
import { SheetViewer } from "./sheet-viewer";
import { ErrorState, LoadingState, makeStyles, MessageState, type Styles, ToolbarButton } from "./ui";
import { useBottomInset } from "./use-bottom-inset";
import { useViewerPosition } from "./use-viewer-position";
import { MediaViewer } from "./media-viewer";
import { kindForPath } from "../shared/kinds";

export function documentTitle(params: Record<string, string>): string {
  return params.path ? baseName(params.path) : "Document";
}

export function DocumentScreen({ theme, layout, params }: PluginScreenProps) {
  const { ref, onLayout, bottomInset } = useBottomInset();
  const styles = useMemo(() => makeStyles(theme, layout.compact, bottomInset), [theme, layout.compact, bottomInset]);
  const workspaceId = params.workspaceId ?? "";
  const path = params.path ?? "";
  const documentKey = `${workspaceId}\0${path}`;
  const [unlock, setUnlock] = useState<{ documentKey: string; password: string; attempt: number } | null>(null);
  const unlocked = unlock?.documentKey === documentKey ? unlock : null;
  const password = unlocked?.password;
  const openDocument = useRpc(docOpenRpc);
  const opened = useQuery({
    ...documentQueryOptions(workspaceId, path, unlocked?.attempt ?? 0),
    queryFn: () => openDocument({ workspaceId, path, password }),
    retry: false,
  });
  const prompt = passwordPrompt(opened.error);
  const checking = unlocked !== null && opened.status === "pending";

  let body: ReactNode;
  if (!workspaceId || !path) {
    body = (
      <View style={styles.screen}>
        <MessageState theme={theme} styles={styles} icon="FileX" title="No document selected" />
      </View>
    );
  } else if (!opened.data && (prompt || checking)) {
    body = (
      <View style={styles.screen}>
        <PasswordPrompt
          theme={theme}
          styles={styles}
          compact={layout.compact}
          incorrect={prompt?.incorrect ?? false}
          busy={checking}
          onSubmit={(value) => setUnlock({ documentKey, password: value, attempt: (unlocked?.attempt ?? 0) + 1 })}
        />
      </View>
    );
  } else if (!opened.data) {
    body = (
      <View style={styles.screen}>
        {opened.error ? (
          <ErrorState theme={theme} styles={styles} error={opened.error} onRetry={() => void opened.refetch()} />
        ) : (
          <LoadingState theme={theme} styles={styles} />
        )}
      </View>
    );
  } else {
    body = (
      <DocumentBody key={documentKey} document={opened.data} workspaceId={workspaceId} path={path} password={password} theme={theme} styles={styles} />
    );
  }
  return (
    <View ref={ref} onLayout={onLayout} style={{ flex: 1 }}>
      {workspaceId && kindForPath(path) && canDownloadOriginal ? <View style={styles.toolbar}><DownloadOriginal key={documentKey} workspaceId={workspaceId} path={path} theme={theme} styles={styles} /></View> : null}
      {body}
    </View>
  );
}

function ViewerContent({
  document,
  workspaceId,
  path,
  password,
  theme,
  styles,
  navigation,
}: {
  navigation?: SearchNavigation | null;
  document: DocOpenOutput;
  workspaceId: string;
  path: string;
  password?: string;
  theme: PluginScreenProps["theme"];
  styles: Styles;
}) {
  const position = useViewerPosition(workspaceId, path);
  const remembers = ["pdf", "pptx", "image-raster", "image-decoded", "xlsx", "csv"].includes(document.kind);
  if (remembers && !position.ready) return <LoadingState theme={theme} styles={styles} />;
  const common = { workspaceId, path, revision: document.revision, theme, styles, navigation };
  const remembered = { initialPosition: position.initial, onPositionChange: position.save };
  const key = `${workspaceId}\0${path}`;
  switch (document.kind) {
    case "pdf":
      return <PageViewer key={key} {...common} {...remembered} kind="pdf" count={document.pageCount} password={password} />;
    case "pptx":
      return <PageViewer key={key} {...common} {...remembered} kind="pptx" count={document.slideCount} />;
    case "image-raster":
    case "image-decoded":
      return <PageViewer key={key} {...common} {...remembered} kind="image" count={1} animation={document.animation} />;
    case "docx":
      return <BlocksViewer key={key} {...common} />;
    case "xlsx":
    case "csv":
      return <SheetViewer key={key} {...common} {...remembered} sheets={document.sheets} />;
    case "video":
    case "audio":
      return <MediaViewer key={key} {...common} kind={document.kind} mimeType={document.mimeType} size={document.size} />;
  }
}

function DocumentBody(props: Parameters<typeof ViewerContent>[0]) {
  const [finding, setFinding] = useState(false);
  const [navigation, setNavigation] = useState<SearchNavigation | null>(null);
  useEffect(() => setNavigation(null), [props.document.revision]);
  const searchable = ["pdf", "docx", "xlsx", "csv", "pptx"].includes(props.document.kind);
  return <FindScope enabled={searchable} onFind={() => { if (searchable) setFinding(true); }}>
    <View style={props.styles.screen}>
    {searchable ? <View style={props.styles.toolbar}><ToolbarButton theme={props.theme} styles={props.styles}
      icon="Search" label="Find in document" selected={finding} onPress={() => { setFinding(!finding); if (finding) setNavigation(null); }} /></View> : null}
    {finding ? <FindPanel key={props.document.revision} workspaceId={props.workspaceId} path={props.path} password={props.password}
      revision={props.document.revision} pageLabel={props.document.kind === "pptx" ? "Slide" : "Page"} theme={props.theme} styles={props.styles} onNavigate={setNavigation}
      onClose={() => { setFinding(false); setNavigation(null); }} /> : null}
    <ViewerContent {...props} navigation={navigation} />
  </View></FindScope>;
}
