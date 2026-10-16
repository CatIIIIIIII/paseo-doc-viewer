import { type PluginScreenProps, useRpc } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import { type ReactNode, useMemo, useState } from "react";
import { View } from "react-native";
import { docOpenRpc, type DocOpenOutput } from "../shared/rpc";
import { BlocksViewer } from "./blocks-viewer";
import { baseName } from "./format";
import { PageViewer } from "./page-viewer";
import { passwordPrompt } from "./password";
import { PasswordPrompt } from "./password-prompt";
import { documentQueryOptions } from "./queries";
import { SheetViewer } from "./sheet-viewer";
import { ErrorState, LoadingState, makeStyles, MessageState, type Styles } from "./ui";
import { useBottomInset } from "./use-bottom-inset";
import { VideoViewer } from "./video-viewer";

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
      <DocumentBody document={opened.data} workspaceId={workspaceId} path={path} password={password} theme={theme} styles={styles} />
    );
  }
  return (
    <View ref={ref} onLayout={onLayout} style={{ flex: 1 }}>
      {body}
    </View>
  );
}

function DocumentBody({
  document,
  workspaceId,
  path,
  password,
  theme,
  styles,
}: {
  document: DocOpenOutput;
  workspaceId: string;
  path: string;
  password?: string;
  theme: PluginScreenProps["theme"];
  styles: Styles;
}) {
  const common = { workspaceId, path, revision: document.revision, theme, styles };
  const key = `${workspaceId}\0${path}`;
  switch (document.kind) {
    case "pdf":
      return <PageViewer key={key} {...common} kind="pdf" count={document.pageCount} password={password} />;
    case "pptx":
      return <PageViewer key={key} {...common} kind="pptx" count={document.slideCount} />;
    case "image-raster":
    case "image-decoded":
      return <PageViewer key={key} {...common} kind="image" count={1} animation={document.animation} />;
    case "docx":
      return <BlocksViewer {...common} />;
    case "xlsx":
    case "csv":
      return <SheetViewer {...common} sheets={document.sheets} />;
    case "video":
      return <VideoViewer {...common} mimeType={document.mimeType} size={document.size} />;
  }
}
