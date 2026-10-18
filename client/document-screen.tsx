import type { SearchMatch, SearchNavigation } from "../shared/search";
import { FindPanel } from "./find-panel";
import { FindScope } from "./web";
import { DownloadOriginal } from "./download-original";
import { type PluginScreenProps, useRpc } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { View } from "react-native";
import { docOpenRpc, type DocOpenOutput } from "../shared/rpc";
import { BlocksViewer } from "./blocks-viewer";
import { originalReachable } from "./format";
import { PageViewer } from "./page-viewer";
import { passwordPrompt } from "./password";
import { PasswordPrompt } from "./password-prompt";
import { documentQueryOptions } from "./queries";
import { SheetViewer } from "./sheet-viewer";
import { ErrorState, LoadingState, makeStyles, MessageState, StatusPill, type Styles, ToolbarButton } from "./ui";
import { useBottomInset } from "./use-bottom-inset";
import { useViewerPosition } from "./use-viewer-position";
import { useViewerMarks } from "./use-viewer-marks";
import { type DocumentReview, reviewStatus } from "./review";
import { MediaViewer } from "./media-viewer";
import { kindForPath } from "../shared/kinds";
import { openHostScreen } from "./host-client";
import { reviewDrafts, reviewScope, useReviewDraft } from "./review-draft";
import { NoteComposer, reviewScreen } from "./review-note";

export function DocumentScreen({ host, theme, layout, params }: PluginScreenProps) {
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
  // The original stays downloadable when the preview cannot open.
  const download = workspaceId && kindForPath(path) ? <DownloadOriginal key={documentKey} workspaceId={workspaceId} path={path} theme={theme} styles={styles} standalone /> : null;

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
        >
          {download}
        </PasswordPrompt>
      </View>
    );
  } else if (!opened.data) {
    body = (
      <View style={styles.screen}>
        {opened.error ? (
          <ErrorState theme={theme} styles={styles} error={opened.error} onRetry={() => void opened.refetch()}>
            {originalReachable(opened.error) ? download : null}
          </ErrorState>
        ) : (
          <LoadingState theme={theme} styles={styles} />
        )}
      </View>
    );
  } else {
    body = (
      <DocumentBody key={documentKey} document={opened.data} workspaceId={workspaceId} path={path} password={password} compact={layout.compact}
        reviewScope={reviewScope(host?.id, workspaceId)} theme={theme} styles={styles} />
    );
  }
  return (
    <View ref={ref} onLayout={onLayout} style={{ flex: 1 }}>
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
  searchMatches,
  pageMap,
  onActivePage,
  onOpenPageMap,
}: {
  navigation?: SearchNavigation | null;
  searchMatches?: SearchMatch[];
  pageMap?: { compact: boolean; onClose(): void } | null;
  compact: boolean;
  onActivePage?: (index: number) => void;
  onOpenPageMap?: () => void;
  document: DocOpenOutput;
  workspaceId: string;
  path: string;
  password?: string;
  theme: PluginScreenProps["theme"];
  styles: Styles;
}) {
  const position = useViewerPosition(workspaceId, path);
  const remembers = ["pdf", "pptx", "image-raster", "image-decoded", "xlsx", "csv", "jsonl", "parquet"].includes(document.kind);
  if (remembers && !position.ready) return <LoadingState theme={theme} styles={styles} />;
  const common = { workspaceId, path, revision: document.revision, theme, styles, navigation };
  const remembered = { initialPosition: position.initial, onPositionChange: position.save };
  const key = `${workspaceId}\0${path}`;
  switch (document.kind) {
    case "pdf":
      return <PageViewer key={key} {...common} {...remembered} kind="pdf" count={document.pageCount} password={password} searchMatches={searchMatches} pageMap={pageMap} onActivePage={onActivePage} onOpenPageMap={onOpenPageMap} />;
    case "pptx":
      return <PageViewer key={key} {...common} {...remembered} kind="pptx" count={document.slideCount} />;
    case "image-raster":
    case "image-decoded":
      return <PageViewer key={key} {...common} {...remembered} kind="image" count={1} animation={document.animation} />;
    case "docx":
      return <BlocksViewer key={key} {...common} />;
    case "xlsx":
    case "csv":
    case "jsonl":
    case "parquet":
      return <SheetViewer key={key} {...common} {...remembered} kind={document.kind} sheets={document.sheets} />;
    case "video":
    case "audio":
      return <MediaViewer key={key} {...common} kind={document.kind} mimeType={document.mimeType} size={document.size} />;
  }
}

function DocumentBody({ reviewScope: scope, ...props }: Parameters<typeof ViewerContent>[0] & { reviewScope: string }) {
  const [finding, setFinding] = useState(false);
  // A note being typed when the viewer was unmounted (for example by a workspace switch) reopens.
  const [notePage, setNotePage] = useState<number | null>(() => {
    const kept = reviewDrafts.composing(scope, props.path);
    return kept && props.document.kind === "pdf" && kept.page < props.document.pageCount ? kept.page : null;
  });
  const shownRevision = useRef(props.document.revision);
  const draft = useReviewDraft(scope);
  const marks = useViewerMarks(props.workspaceId, props.path);
  const review = reviewStatus(marks.review, props.document.revision);
  const [navigation, setNavigation] = useState<SearchNavigation | null>(null);
  const [searchMatches, setSearchMatches] = useState<SearchMatch[]>([]);
  const [mapOpen, setMapOpen] = useState(false);
  const [activePage, setActivePage] = useState(0);
  useEffect(() => {
    if (shownRevision.current === props.document.revision) return;
    shownRevision.current = props.document.revision;
    setNavigation(null); setSearchMatches([]); setNotePage(null);
  }, [props.document.revision]);
  useEffect(() => { if (navigation) setMapOpen(false); }, [navigation]);
  const searchable = ["pdf", "docx", "xlsx", "csv", "jsonl", "parquet", "pptx"].includes(props.document.kind);
  // Page map and review notes act on a PDF page, so both need at least one.
  const paged = props.document.kind === "pdf" && props.document.pageCount > 0;
  const pageMap = useMemo(() => (mapOpen ? { compact: props.compact, onClose: () => setMapOpen(false) } : null), [mapOpen, props.compact]);
  return <FindScope enabled={searchable} onFind={() => { if (searchable) setFinding(true); }}>
    <View style={props.styles.screen}>
    <View style={props.styles.toolbar}>
      {searchable ? <ToolbarButton theme={props.theme} styles={props.styles} icon="Search" label={props.compact ? undefined : "Find in document"} accessibilityLabel="Find in document"
        variant="toggle" selected={finding} onPress={() => { setFinding(!finding); if (finding) { setNavigation(null); setSearchMatches([]); } }} /> : null}
      {/* Status sits left of the spacer, so it appearing never moves the buttons. */}
      {marks.ready && review !== "never" ? <StatusPill theme={props.theme} styles={props.styles} status={review} label={props.compact ? "none" : "full"} /> : null}
      <View style={props.styles.toolbarSpacer} />
      {paged ? <ToolbarButton theme={props.theme} styles={props.styles} icon="LayoutGrid" label={props.compact ? undefined : "Pages"} accessibilityLabel="Page map"
        variant="toggle" selected={mapOpen} onPress={() => setMapOpen(!mapOpen)} /> : null}
      {paged ? <ToolbarButton theme={props.theme} styles={props.styles} icon="MessageSquarePlus" label={props.compact ? undefined : "Add note"}
        accessibilityLabel={`Add note to page ${activePage + 1}`} variant="toggle" selected={notePage !== null} onPress={() => setNotePage(notePage === null ? activePage : null)} /> : null}
      {draft.notes.length > 0 ? <ToolbarButton theme={props.theme} styles={props.styles} icon="ClipboardList"
        label={props.compact ? String(draft.notes.length) : `Review (${draft.notes.length})`}
        accessibilityLabel={`Review notes (${draft.notes.length})`} onPress={() => openHostScreen(reviewScreen(props.workspaceId))} /> : null}
      {marks.ready ? <MarkReviewed marks={marks} status={review} revision={props.document.revision} compact={props.compact} theme={props.theme} styles={props.styles} /> : null}
      <DownloadOriginal workspaceId={props.workspaceId} path={props.path} theme={props.theme} styles={props.styles} />
    </View>
    {notePage !== null ? <NoteComposer key={notePage} scope={scope} workspaceId={props.workspaceId} path={props.path} revision={props.document.revision}
      page={notePage} password={props.password} draft={draft} theme={props.theme} styles={props.styles} onClose={() => setNotePage(null)} /> : null}
    {finding ? <FindPanel key={props.document.revision} workspaceId={props.workspaceId} path={props.path} password={props.password}
      revision={props.document.revision} pageLabel={props.document.kind === "pptx" ? "Slide" : "Page"} theme={props.theme} styles={props.styles} onNavigate={setNavigation}
      onMatches={setSearchMatches}
      onClose={() => { setFinding(false); setNavigation(null); setSearchMatches([]); }} /> : null}
    <ViewerContent {...props} navigation={navigation} searchMatches={searchMatches} pageMap={pageMap} onActivePage={paged ? setActivePage : undefined}
      onOpenPageMap={paged ? () => setMapOpen(true) : undefined} />
  </View></FindScope>;
}

// Marking is always an explicit press, for the revision on screen; opening or scrolling never marks.
function MarkReviewed({ marks, status, revision, compact, theme, styles }: {
  marks: ReturnType<typeof useViewerMarks>; status: DocumentReview; revision: string; compact: boolean; theme: PluginScreenProps["theme"]; styles: Styles;
}) {
  const reviewed = status === "reviewed";
  return <ToolbarButton theme={theme} styles={styles} icon="Check" label={compact ? undefined : "Mark reviewed"}
    accessibilityLabel={reviewed ? "Reviewed, clear the review mark" : "Mark reviewed"} variant="toggle" selected={reviewed}
    disabled={marks.saving} onPress={() => void marks.setReview(reviewed ? null : revision)} />;
}
