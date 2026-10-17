import { revisionModifiedAt, revisionSize } from "../shared/revision";
import { pageImageKey, type ReviewDraft, type ReviewNote } from "./review-draft";

export type RevisionStatus = "current" | "older" | "unknown";

export interface ReviewMessage {
  readonly text: string;
  readonly images: readonly { data: string; mimeType: string }[];
}

const INTRO =
  "Review notes from the document viewer. Each file gives the modified time and size of the version I was viewing, then my notes by page (numbered from 1).";

export function noteRevisionStatus(note: Pick<ReviewNote, "revision">, currentRevision: string | undefined): RevisionStatus {
  if (currentRevision === undefined) return "unknown";
  return note.revision === currentRevision ? "current" : "older";
}

export function modifiedLabel(revision: string): string | null {
  const modified = revisionModifiedAt(revision);
  if (modified === null) return null;
  return `${new Date(modified).toISOString().slice(0, 19).replace("T", " ")} UTC`;
}

// What an agent can check against the file: modified time and exact size, not the opaque revision token.
export function versionLabel(revision: string): string | null {
  const modified = modifiedLabel(revision);
  const size = revisionSize(revision);
  if (modified === null || size === null) return null;
  return `modified ${modified}, ${size.toLocaleString("en-US")} bytes`;
}

export type PinLabel = (note: Pick<ReviewNote, "path" | "page" | "revision">) => string | undefined;

interface Group {
  path: string;
  revision: string;
  older: boolean;
  notes: ReviewNote[];
}

function groupNotes(notes: readonly ReviewNote[], currentRevision: (path: string) => string | undefined): Group[] {
  const groups = new Map<string, Group>();
  const pathOrder = new Map<string, number>();
  for (const note of notes) {
    if (!pathOrder.has(note.path)) pathOrder.set(note.path, pathOrder.size);
    const key = `${note.path}\0${note.revision}`;
    const group = groups.get(key) ?? { path: note.path, revision: note.revision, older: noteRevisionStatus(note, currentRevision(note.path)) === "older", notes: [] };
    group.notes.push(note);
    groups.set(key, group);
  }
  return [...groups.values()]
    .map((group) => ({ ...group, notes: [...group.notes].sort((a, b) => a.page - b.page) }))
    .sort((a, b) => pathOrder.get(a.path)! - pathOrder.get(b.path)! || Number(a.older) - Number(b.older));
}

export function formatReview(draft: ReviewDraft, currentRevision: (path: string) => string | undefined, pinLabel: PinLabel = () => undefined): ReviewMessage {
  const imageNumbers = new Map<string, number>();
  const images: { data: string; mimeType: string }[] = [];
  const imageLines: string[] = [];
  const sections = groupNotes(draft.notes, currentRevision).map((group) => {
    const version = versionLabel(group.revision);
    const heading = `${group.path}${group.older ? ", older version" : ""}${version ? ` (${version})` : ""}`;
    const lines = group.notes.map((note) => {
      const key = pageImageKey(note);
      const image = draft.images[key];
      let marker = "";
      if (image) {
        if (!imageNumbers.has(key)) {
          imageNumbers.set(key, images.length + 1);
          images.push({ data: image.data, mimeType: image.mimeType });
          const version = versionLabel(note.revision);
          imageLines.push(`${images.length}. ${note.path} page ${note.page + 1}${version ? ` (${version})` : ""}`);
        }
        marker = ` [image ${imageNumbers.get(key)}]`;
      }
      // A pin label is one line, so a typed newline cannot start a line of its own in the message.
      const pin = pinLabel(note)?.replace(/\s+/g, " ").trim();
      return `- Page ${note.page + 1}${pin ? ` (pinned as "${pin}")` : ""}: ${note.text.replace(/\n/g, "\n  ")}${marker}`;
    });
    return [group.older ? `${heading}; the file has changed since these notes` : heading, ...lines].join("\n");
  });
  const parts = [INTRO, ...sections];
  if (imageLines.length > 0) parts.push(["Attached images:", ...imageLines].join("\n"));
  return { text: parts.join("\n\n"), images };
}
