import { ERROR_MESSAGES, isError } from "../shared/errors";
import { KIND_REGISTRY, type DocumentKind } from "../shared/kinds";
import { revisionChangedAt } from "../shared/revision";
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
export const TURN_THUMBNAIL_WIDTH = 80;
export const TURN_THUMBNAIL_MAX_BYTES = 64 * 1024 * 1024;
const TURN_THUMBNAIL_RETRIES = 3;
const TURN_THUMBNAIL_RETRY_MS = 4_000;

export const hasThumbnail = (kind: DocumentKind) => KIND_REGISTRY[kind].rpcs.includes("doc.thumbnail");

export const cardThumbnail = (file: Pick<TurnDocsFile, "kind" | "size">) => hasThumbnail(file.kind) && file.size <= TURN_THUMBNAIL_MAX_BYTES;

// Only a busy daemon is asked again, later each time and at a random point, so cards do not come back
// together. Work that ran out of time is not: it would again, and on a PDF it restarts PDFium.
export function cardThumbnailRetry(error: unknown, failures: number, random = Math.random): number | null {
  if (!isError(error, ERROR_MESSAGES.busy()) || failures > TURN_THUMBNAIL_RETRIES) return null;
  return Math.round(TURN_THUMBNAIL_RETRY_MS * failures * (0.5 + random()));
}

export type TurnFilePill = "new" | "changed" | "opened";

// Opened at the card's revision, or at one changed strictly later; a tie between two different
// revisions cannot say which came first, so it keeps the turn's verdict.
export function turnFilePill(file: Pick<TurnDocsFile, "status" | "revision">, opened: string | undefined): TurnFilePill {
  if (opened === undefined) return file.status;
  if (opened === file.revision) return "opened";
  const openedAt = revisionChangedAt(opened);
  const changedAt = revisionChangedAt(file.revision);
  return openedAt !== null && changedAt !== null && openedAt > changedAt ? "opened" : file.status;
}

export const TURN_FILE_PILL = {
  new: { status: "new", spoken: "new" },
  changed: { status: "modified", spoken: "changed during this turn" },
  opened: { status: "opened", spoken: "opened since this turn" },
} as const satisfies Record<TurnFilePill, { status: string; spoken: string }>;
