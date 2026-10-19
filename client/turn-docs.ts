import { KIND_REGISTRY, type DocumentKind } from "../shared/kinds";
import { revisionModifiedAt } from "../shared/revision";
import type { TurnDocs, TurnDocsFile } from "../shared/turn-docs";

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

// Shown only when the host cannot open the settings screen, so the user still knows where the switch lives.
export const TURN_CARDS_SETTING_HINT = "Turn these cards off in Settings, Document viewer.";

export const TURN_THUMBNAIL_SIZE = { compact: 36, wide: 40 } as const;

export const hasThumbnail = (kind: DocumentKind) => KIND_REGISTRY[kind].rpcs.includes("doc.thumbnail");

export type TurnFilePill = "new" | "changed" | "opened";

export function turnFilePill(file: Pick<TurnDocsFile, "status" | "revision">, opened: string | undefined): TurnFilePill {
  if (opened === undefined) return file.status;
  if (opened === file.revision) return "opened";
  const openedAt = revisionModifiedAt(opened);
  const changedAt = revisionModifiedAt(file.revision);
  return openedAt !== null && changedAt !== null && openedAt >= changedAt ? "opened" : file.status;
}

export const TURN_FILE_PILL = {
  new: { status: "new", spoken: "new" },
  changed: { status: "modified", spoken: "changed during this turn" },
  opened: { status: "opened", spoken: "opened since this turn" },
} as const satisfies Record<TurnFilePill, { status: string; spoken: string }>;
