import type { TurnDocs } from "../shared/turn-docs";

// "Changed while this turn ran", never "written by this agent": the card comes from file times,
// so another agent or the user editing the same workspace shows up here too.
export function turnDocsTitle(data: Pick<TurnDocs, "files" | "moreCount">): string {
  const total = data.files.length + data.moreCount;
  return `${total} ${total === 1 ? "document" : "documents"} changed while this turn ran`;
}

export function turnDocsNote(data: Pick<TurnDocs, "outcome" | "partial">): string | null {
  const notes = [
    data.outcome === "canceled" ? "Turn was stopped" : data.outcome === "failed" ? "Turn failed" : null,
    data.partial ? "Large workspace: only part of it was scanned" : null,
  ].filter((note): note is string => note !== null);
  return notes.length > 0 ? notes.join(" · ") : null;
}
