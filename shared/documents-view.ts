import { z } from "zod";

export const DOCUMENT_VIEWS = ["list", "details", "previews"] as const;
export const documentView = z.enum(DOCUMENT_VIEWS);
export type DocumentView = z.infer<typeof documentView>;
export const DEFAULT_DOCUMENT_VIEW: DocumentView = "list";

export const documentViews = z.object({ compact: documentView.optional(), wide: documentView.optional() });
export type DocumentViews = z.infer<typeof documentViews>;
