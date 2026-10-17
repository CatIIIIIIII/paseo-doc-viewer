import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DocumentScreen } from "../../client/document-screen";
import { createDocumentsPanel } from "../../client/documents-panel";
const query = new QueryClient({ defaultOptions: { queries: { retry: false } } });
const theme = { colors: { foreground: "#e5e7eb", foregroundMuted: "#9ca3af", surface0: "#111827", surface1: "#1f2937", surface2: "#374151", border: "#4b5563", accent: "#6366f1", accentForeground: "#fff", statusDanger: "#f87171", statusWarning: "#fbbf24", statusSuccess: "#34d399" } };
function App() {
  const [path, setPath] = useState("statement.pdf");
  const [opened, setOpened] = useState(true);
  const [browsing, setBrowsing] = useState(false);
  const [Panel] = useState(() => createDocumentsPanel((input) => { setPath(input.params!.path!); setBrowsing(false); setOpened(true); }));
  return <QueryClientProvider client={query}>
    <nav style={{ display: "flex", gap: 8, marginBottom: 12 }}>{["statement.pdf", "invoices.xlsx", "contract.docx", "deck.pptx", "tone.wav", "audible.webm", "broken.pdf", "many.csv", "long.pdf", "report.pdf", "forecast.xlsx", ".env"].map((file) => <button key={file} onClick={() => { setPath(file); setOpened(true); setBrowsing(false); }}>{file}</button>)}
      <button onClick={() => setBrowsing(true)}>Documents</button>
      <button onClick={() => setOpened(!opened)}>{opened ? "Close viewer" : "Reopen viewer"}</button></nav>
    <main style={{ display: "flex", height: 780, width: 950 }}>{browsing ? <Panel context="workspace" workspaceId="workspace" theme={theme as any} layout={{ compact: false } as any} {...({} as any)} /> : opened ? <DocumentScreen key={path} host={{} as any} theme={theme as any} layout={{ compact: false } as any} params={{ workspaceId: "workspace", path }} /> : null}</main>
  </QueryClientProvider>;
}
createRoot(document.getElementById("root")!).render(<App />);
