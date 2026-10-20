import type { PluginClientContext } from "@getpaseo/plugin/client";
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
  const cleanups = [
    client.addScreen({ id: DOCUMENT_SCREEN_ID, title: documentTitle, Component: DocumentScreen }),
    client.addCommandCenterItem({
      id: "open-recent-document",
      title: "Open recent document",
      icon: "FileText",
      keywords: ["pdf", "docx", "xlsx", "csv", "tsv", "jsonl", "ndjson", "parquet", "pptx", "viewer", "latest", "mp3", "m4a", "wav", "flac", "audio", "video"],
      context: "workspace",
      onSelect: openMostRecent,
    }),
    client.addCommandCenterItem({
      id: "show-documents",
      title: "Show documents",
      icon: "FileText",
      keywords: ["recent", "viewer"],
      context: "workspace",
      onSelect: ({ openPanel }) => openPanel(DOCUMENTS_PANEL_ID),
    }),
    client.addWorkspacePanel({
      id: DOCUMENTS_PANEL_ID,
      title: "Documents",
      icon: "FileText",
      context: "workspace",
      locations: ["workspace", "explorer"],
      Component: createDocumentsPanel((input) => client.openScreen(input)),
    }),
    client.addSlashCommand({
      name: "doc",
      description: "Open a document in the viewer, or the newest PDF, Word, spreadsheet or slide file",
      argumentHint: "[path]",
      context: "workspace",
      onSubmit: openByPath,
    }),
    addDocumentsHeaderButtons(client),
    client.addScreen({ id: REVIEW_SCREEN_ID, title: "Review notes", Component: ReviewScreen }),
    client.addCommandCenterItem({
      id: "show-review-notes",
      title: "Show review notes",
      icon: "ClipboardList",
      keywords: ["review", "notes", "feedback", "send", "agent", "pdf"],
      context: "workspace",
      onSelect: ({ openScreen, workspace }) => openScreen(reviewScreen(workspace.id)),
    }),
    ...turnDocsRenderers(client),
    client.addSettingsScreen({ id: SETTINGS_SCREEN_ID, title: "Document viewer", icon: "FileText", Component: ViewerSettings }),
  ];
  return () => {
    setHostClient(null);
    for (const cleanup of cleanups) cleanup();
  };
}

// Renderers match the exact version. Cards without folder rows are still written as version 1 (TurnDocsRow).
function turnDocsRenderers(client: PluginClientContext) {
  const Card = createTurnDocsCard(client);
  return [
    client.addTimelineRenderer({ kind: TURN_DOCS_KIND, version: 1, schema: turnDocsV1Schema, Component: legacyTurnDocsCard(Card) }),
    client.addTimelineRenderer({ kind: TURN_DOCS_KIND, version: 2, schema: turnDocsSchema, Component: Card }),
  ];
}
