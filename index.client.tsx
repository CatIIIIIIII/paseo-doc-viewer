import type { PluginClientContext } from "@getpaseo/plugin/client";
import { DocumentScreen, documentTitle } from "./client/document-screen";
import { createDocumentsPanel } from "./client/documents-panel";
import { DOCUMENT_SCREEN_ID, DOCUMENTS_PANEL_ID, openByPath, openMostRecent } from "./client/recent";

export default function contribute(client: PluginClientContext) {
  const cleanups = [
    client.addScreen({ id: DOCUMENT_SCREEN_ID, title: documentTitle, Component: DocumentScreen }),
    client.addCommandCenterItem({
      id: "open-recent-document",
      title: "Open recent document",
      icon: "FileText",
      keywords: ["pdf", "docx", "xlsx", "pptx", "viewer", "latest"],
      context: "workspace",
      onSelect: openMostRecent,
    }),
    client.addCommandCenterItem({
      id: "show-documents",
      title: "Show documents",
      icon: "Files",
      keywords: ["recent", "viewer"],
      context: "workspace",
      onSelect: ({ openPanel }) => openPanel(DOCUMENTS_PANEL_ID),
    }),
    client.addWorkspacePanel({
      id: DOCUMENTS_PANEL_ID,
      title: "Documents",
      icon: "Files",
      context: "workspace",
      locations: ["workspace", "explorer"],
      Component: createDocumentsPanel((input) => client.openScreen(input)),
    }),
    client.addSlashCommand({
      name: "doc",
      description: "Open a document in the viewer, or the most recent one",
      argumentHint: "[path]",
      context: "workspace",
      onSubmit: openByPath,
    }),
  ];
  return () => {
    for (const cleanup of cleanups) cleanup();
  };
}
