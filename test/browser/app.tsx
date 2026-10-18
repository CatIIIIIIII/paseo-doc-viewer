import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DocumentScreen } from "../../client/document-screen";
import { createDocumentsPanel } from "../../client/documents-panel";
import { setHostClient } from "../../client/host-client";
import { ReviewScreen } from "../../client/review-screen";
import { createTurnDocsCard } from "../../client/turn-docs-card";
const query = new QueryClient({ defaultOptions: { queries: { retry: false } } });
const theme = { colors: { foreground: "#e5e7eb", foregroundMuted: "#9ca3af", surface0: "#111827", surface1: "#1f2937", surface2: "#374151", border: "#4b5563", accent: "#6366f1", accentForeground: "#fff", statusDanger: "#f87171", statusWarning: "#fbbf24", statusSuccess: "#34d399" } };
// Fake agents: "racing" reads as idle in the list but busy when re-checked at submission,
// and "broken" rejects the send, so both must leave the draft in place.
const agent = (id: string, title: string, status: string, updatedAt: string, workspaceId = "workspace") =>
  ({ id, title, status, updatedAt, workspaceId, provider: "claude", pendingPermissions: [] });
const agents = [
  agent("busy", "Busy agent", "running", "2026-10-17T12:00:00.000Z"),
  agent("docs", "Docs agent", "idle", "2026-10-17T11:00:00.000Z"),
  agent("racing", "Racing agent", "idle", "2026-10-17T10:00:00.000Z"),
  agent("broken", "Broken agent", "idle", "2026-10-17T09:00:00.000Z"),
  agent("elsewhere", "Other workspace agent", "idle", "2026-10-17T13:00:00.000Z", "other"),
];
const sent: unknown[] = [];
(window as any).__sentReviews = sent;
// Replaces the agent, so the next agent list poll sees a changed entry.
(window as any).__setAgentStatus = (id: string, status: string) => {
  const index = agents.findIndex((each) => each.id === id);
  agents[index] = { ...agents[index], status };
};
(globalThis as any).__fakePaseo = { agents: {
  list: async () => ({ entries: agents.map((each) => ({ agent: each })) }),
  ref: (id: string) => ({
    refresh: async () => { const found = agents.find((each) => each.id === id); return found ? { agent: id === "racing" ? { ...found, status: "running" } : found } : null; },
    send: async (text: string, options: unknown) => { if (id === "broken") throw new Error("sendAgentMessage rejected"); sent.push({ id, text, options }); },
  }),
} };
// ?compact renders the phone layout at phone width, for toolbar fit checks.
const compact = new URLSearchParams(location.search).has("compact");
// ?settingsFail makes openSettings throw, as a host does when it cannot open the screen.
const settingsFail = new URLSearchParams(location.search).has("settingsFail");
const openedSettings: string[] = [];
(window as any).__openedSettings = openedSettings;
const TurnCard = createTurnDocsCard({
  openScreen: (input: unknown) => { (window as any).__openedScreen = input; },
  openPanel: (id: string) => { (window as any).__openedPanel = id; },
  openSettings: (id: string) => { if (settingsFail) throw new Error("No settings screen"); openedSettings.push(id); },
} as any);
const turnFile = (path: string, kind: string, status: "new" | "changed", size: number) => ({ path, kind, status, size, revision: "r1" });
const turnDocs = { workspaceId: "workspace", startedAt: 0, endedAt: 1, outcome: "completed", partial: false, moreCount: 2, files: [
  turnFile("reports/quarterly-report-with-a-long-file-name.pdf", "pdf", "new", 182_000),
  turnFile("finance/forecast.xlsx", "xlsx", "changed", 24_000),
] };
function App() {
  const [path, setPath] = useState("statement.pdf");
  const [opened, setOpened] = useState(true);
  const [browsing, setBrowsing] = useState(false);
  const [Panel] = useState(() => createDocumentsPanel((input) => { setPath(input.params!.path!); setBrowsing(false); setOpened(true); }));
  const [screen, setScreen] = useState("document");
  useEffect(() => { setHostClient({ openScreen: ({ screenId }: { screenId: string }) => setScreen(screenId) } as any); return () => setHostClient(null); }, []);
  const props = { host: {} as any, theme: theme as any, layout: { compact } as any, navigation: { openAgent: ({ agentId }: { agentId: string }) => { (window as any).__openedAgent = agentId; } } as any };
  return <QueryClientProvider client={query}>
    <nav style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 12 }}>{["statement.pdf", "invoices.xlsx", "contract.docx", "deck.pptx", "tone.wav", "clip.mp4", "audible.webm", "animated.webp", "broken.pdf", "many.csv", "long.pdf", "report.pdf", "forecast.xlsx", "evals.jsonl", ".env"].map((file) => <button key={file} onClick={() => { setPath(file); setOpened(true); setBrowsing(false); setScreen("document"); }}>{file}</button>)}
      <button onClick={() => { setBrowsing(true); setScreen("document"); }}>Documents</button>
      <button onClick={() => setScreen("turn-card")}>Turn card</button>
      <button onClick={() => setOpened(!opened)}>{opened ? "Close viewer" : "Reopen viewer"}</button></nav>
    <main style={{ display: "flex", height: 780, width: compact ? 390 : 950 }}>{screen === "turn-card"
      ? <div aria-label="Turn card frame" style={{ width: "100%" }}><TurnCard {...props} agentId="docs" timestamp={new Date(0)} item={{ type: "plugin", kind: "turn-docs", version: 1, data: turnDocs } as any} /></div>
      : screen === "review"
      ? <ReviewScreen {...props} params={{ workspaceId: "workspace" }} />
      : browsing ? <Panel context="workspace" workspaceId="workspace" theme={theme as any} layout={{ compact: false } as any} {...({} as any)} />
      : opened ? <DocumentScreen key={path} {...props} params={{ workspaceId: "workspace", path }} /> : null}</main>
  </QueryClientProvider>;
}
createRoot(document.getElementById("root")!).render(<App />);
