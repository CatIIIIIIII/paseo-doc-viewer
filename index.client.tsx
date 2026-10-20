import type { PluginClientContext } from "@getpaseo/plugin/client";
import { Dimensions } from "react-native";
import { COMPACT_WINDOW_MAX, type DocumentOpener, type OpenChoice, openPreference, openTarget } from "./client/open-target";
import { viewerSettingsRpc } from "./shared/settings";
import { createPanelReader } from "./client/panel-reader";
import { DocumentScreen } from "./client/document-screen";
import { documentTitle } from "./client/format";
import { createDocumentsPanel } from "./client/documents-panel";
import { addDocumentsHeaderButtons } from "./client/header-button";
import { setHostClient } from "./client/host-client";
import { DOCUMENT_SCREEN_ID, DOCUMENTS_PANEL_ID, openByPath, openMostRecent, SETTINGS_SCREEN_ID } from "./client/recent";
import { REVIEW_SCREEN_ID, reviewScreen } from "./client/review-note";
import { ReviewScreen } from "./client/review-screen";
import { ViewerSettings } from "./client/settings-screen";
import { createTurnDocsCard, legacyTurnDocsCard } from "./client/turn-docs-card";
import { TURN_DOCS_KIND, turnDocsSchema, turnDocsV1Schema } from "./shared/turn-docs";

export default function contribute(client: PluginClientContext) {
  setHostClient(client);
  const reader = createPanelReader();
  const readSettings = () => client.rpc(viewerSettingsRpc.read, {});
  const openDocument: DocumentOpener = (input, layout) => {
    const { workspaceId, path, siblings } = input.params ?? {};
    if (input.screenId !== DOCUMENT_SCREEN_ID || !workspaceId || !path) {
      client.openScreen(input);
      return;
    }
    const windowWidth = Dimensions.get("window").width;
    const compact = layout?.compact ?? windowWidth < COMPACT_WINDOW_MAX;
    const route = (choice: OpenChoice | undefined) => {
      const target = openTarget({ compact, panelVisible: reader.visible(workspaceId), choice, windowWidth });
      if (target === "screen") {
        client.openScreen(input);
        return;
      }
      reader.select(workspaceId, { path, siblings });
      if (target === "explorer") client.openPanel(DOCUMENTS_PANEL_ID, { workspaceId, location: "explorer" });
    };
    // A choice already known keeps the press immediate, and phones need none; the read picks up a change
    // made on another client.
    const known = openPreference.current();
    const reading = openPreference.read(readSettings);
    if (known !== undefined || compact) route(known);
    else void reading.then(route);
  };
  // Show documents means the list, not the last document read there.
  const showDocuments = (workspaceId: string) => {
    reader.select(workspaceId, null);
    client.openPanel(DOCUMENTS_PANEL_ID, { workspaceId });
  };
  const cleanups = [
    client.addScreen({ id: DOCUMENT_SCREEN_ID, title: documentTitle, Component: DocumentScreen }),
    client.addCommandCenterItem({
      id: "open-recent-document",
      title: "Open recent document",
      icon: "FileText",
      keywords: ["pdf", "docx", "xlsx", "csv", "tsv", "jsonl", "ndjson", "parquet", "pptx", "viewer", "latest", "mp3", "m4a", "wav", "flac", "audio", "video"],
      context: "workspace",
      onSelect: (context) => openMostRecent({ ...context, openScreen: openDocument, openPanel: () => showDocuments(context.workspace.id) }),
    }),
    client.addCommandCenterItem({
      id: "show-documents",
      title: "Show documents",
      icon: "FileText",
      keywords: ["recent", "viewer"],
      context: "workspace",
      onSelect: ({ workspace }) => showDocuments(workspace.id),
    }),
    client.addWorkspacePanel({
      id: DOCUMENTS_PANEL_ID,
      title: "Documents",
      icon: "FileText",
      context: "workspace",
      locations: ["workspace", "explorer"],
      Component: createDocumentsPanel((input) => client.openScreen(input), reader),
    }),
    client.addSlashCommand({
      name: "doc",
      description: "Open a document in the viewer, or the newest PDF, Word, spreadsheet or slide file",
      argumentHint: "[path]",
      context: "workspace",
      onSubmit: (context) => openByPath({ ...context, openScreen: openDocument, openPanel: () => showDocuments(context.workspace.id) }),
    }),
    addDocumentsHeaderButtons(client, showDocuments),
    client.addScreen({ id: REVIEW_SCREEN_ID, title: "Review notes", Component: ReviewScreen }),
    client.addCommandCenterItem({
      id: "show-review-notes",
      title: "Show review notes",
      icon: "ClipboardList",
      keywords: ["review", "notes", "feedback", "send", "agent", "pdf"],
      context: "workspace",
      onSelect: ({ openScreen, workspace }) => openScreen(reviewScreen(workspace.id)),
    }),
    ...turnDocsRenderers(client, openDocument, showDocuments),
    client.addSettingsScreen({ id: SETTINGS_SCREEN_ID, title: "Document viewer", icon: "FileText", Component: ViewerSettings }),
  ];
  return () => {
    setHostClient(null);
    for (const cleanup of cleanups) cleanup();
  };
}

// Renderers match the exact version. Cards without folder rows are still written as version 1 (TurnDocsRow).
function turnDocsRenderers(client: PluginClientContext, openDocument: DocumentOpener, showDocuments: (workspaceId: string) => void) {
  const Card = createTurnDocsCard({
    openDocument,
    showDocuments,
    openSettings: (...args) => client.openSettings(...args),
    rpc: client.rpc.bind(client),
  });
  return [
    client.addTimelineRenderer({ kind: TURN_DOCS_KIND, version: 1, schema: turnDocsV1Schema, Component: legacyTurnDocsCard(Card) }),
    client.addTimelineRenderer({ kind: TURN_DOCS_KIND, version: 2, schema: turnDocsSchema, Component: Card }),
  ];
}
