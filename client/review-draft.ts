import { useSyncExternalStore } from "react";
import { REVIEW_MAX_IMAGES, REVIEW_MAX_NOTE_CHARS, REVIEW_MAX_NOTES } from "../shared/limits";

// Review drafts live only in this module, which the host evaluates once per plugin
// installation, so every screen and panel of a host shares them until the app reloads.

export interface ReviewNote {
  readonly id: string;
  readonly path: string;
  readonly revision: string;
  readonly page: number;
  readonly text: string;
}

export interface PageImage {
  readonly mimeType: "image/png" | "image/jpeg";
  readonly width: number;
  readonly height: number;
  readonly data: string;
}

export interface ReviewDraft {
  readonly notes: readonly ReviewNote[];
  readonly images: Readonly<Record<string, PageImage>>;
}

const EMPTY: ReviewDraft = { notes: [], images: {} };

export function pageImageKey({ path, revision, page }: Pick<ReviewNote, "path" | "revision" | "page">): string {
  return `${path}\0${revision}\0${page}`;
}

export function createReviewDrafts() {
  const drafts = new Map<string, ReviewDraft>();
  const listeners = new Set<() => void>();
  let serial = 0;
  const get = (workspaceId: string) => drafts.get(workspaceId) ?? EMPTY;
  const set = (workspaceId: string, draft: ReviewDraft) => {
    if (draft.notes.length === 0) drafts.delete(workspaceId);
    else drafts.set(workspaceId, draft);
    for (const listener of listeners) listener();
  };
  const withNotes = (draft: ReviewDraft, notes: readonly ReviewNote[]): ReviewDraft => {
    const kept = new Set(notes.map(pageImageKey));
    const images = Object.fromEntries(Object.entries(draft.images).filter(([key]) => kept.has(key)));
    return { notes, images };
  };
  const clean = (text: string) => text.trim().slice(0, REVIEW_MAX_NOTE_CHARS);

  return {
    get,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    addNote(workspaceId: string, input: Omit<ReviewNote, "id">): ReviewNote | null {
      const draft = get(workspaceId);
      const text = clean(input.text);
      if (!text || draft.notes.length >= REVIEW_MAX_NOTES) return null;
      const note = { ...input, id: `note-${++serial}`, text };
      set(workspaceId, { ...draft, notes: [...draft.notes, note] });
      return note;
    },
    editNote(workspaceId: string, id: string, value: string) {
      const draft = get(workspaceId);
      const text = clean(value);
      if (!text) return;
      set(workspaceId, { ...draft, notes: draft.notes.map((note) => (note.id === id ? { ...note, text } : note)) });
    },
    removeNote(workspaceId: string, id: string) {
      const draft = get(workspaceId);
      set(workspaceId, withNotes(draft, draft.notes.filter((note) => note.id !== id)));
    },
    attachImage(workspaceId: string, key: string, image: PageImage): boolean {
      const draft = get(workspaceId);
      if (!draft.notes.some((note) => pageImageKey(note) === key)) return false;
      if (!(key in draft.images) && Object.keys(draft.images).length >= REVIEW_MAX_IMAGES) return false;
      set(workspaceId, { ...draft, images: { ...draft.images, [key]: image } });
      return true;
    },
    detachImage(workspaceId: string, key: string) {
      const draft = get(workspaceId);
      if (!(key in draft.images)) return;
      const { [key]: _removed, ...images } = draft.images;
      set(workspaceId, { ...draft, images });
    },
    clear(workspaceId: string) {
      set(workspaceId, EMPTY);
    },
  };
}

export type ReviewDrafts = ReturnType<typeof createReviewDrafts>;

export const reviewDrafts = createReviewDrafts();

export function useReviewDraft(workspaceId: string): ReviewDraft {
  return useSyncExternalStore(reviewDrafts.subscribe, () => reviewDrafts.get(workspaceId), () => reviewDrafts.get(workspaceId));
}
