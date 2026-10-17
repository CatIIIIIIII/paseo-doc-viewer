import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DocumentScreen } from "../../client/document-screen";
const query = new QueryClient({ defaultOptions: { queries: { retry: false } } });
const theme = { colors: { foreground: "#e5e7eb", foregroundMuted: "#9ca3af", surface0: "#111827", surface1: "#1f2937", surface2: "#374151", border: "#4b5563", accent: "#6366f1", accentForeground: "#fff", statusDanger: "#f87171" } };
function App() {
  const [path, setPath] = useState("statement.pdf");
  const [opened, setOpened] = useState(true);
  return <QueryClientProvider client={query}>
    <nav style={{ display: "flex", gap: 8, marginBottom: 12 }}>{["statement.pdf", "invoices.xlsx", "contract.docx", "deck.pptx", "tone.wav", "audible.webm", "broken.pdf", "many.csv", ".env"].map((file) => <button key={file} onClick={() => { setPath(file); setOpened(true); }}>{file}</button>)}
      <button onClick={() => setOpened(!opened)}>{opened ? "Close viewer" : "Reopen viewer"}</button></nav>
    <main style={{ display: "flex", height: 780, width: 950 }}>{opened ? <DocumentScreen key={path} host={{} as any} theme={theme as any} layout={{ compact: false } as any} params={{ workspaceId: "workspace", path }} /> : null}</main>
  </QueryClientProvider>;
}
createRoot(document.getElementById("root")!).render(<App />);
