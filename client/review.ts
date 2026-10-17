import type { ReviewMark } from "../shared/viewer-state";

export type DocumentReview = "never" | "reviewed" | "changed";

export function reviewStatus(mark: ReviewMark | null, revision: string): DocumentReview {
  if (!mark) return "never";
  return mark.revision === revision ? "reviewed" : "changed";
}
