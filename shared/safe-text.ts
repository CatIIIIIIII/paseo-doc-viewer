// Text from file names or other people's files reaches places where a newline or a bidi control
// changes meaning: a download name, a line of the review message an agent reads. One rule for both.

// C0 and C1 controls, DEL, line and paragraph separators, and the bidi marks, embeddings,
// overrides and isolates that reorder how the rest of a line displays.
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g;
const LINE_BREAK = /\r\n?|[\n\u000b\u000c\u0085\u2028\u2029]/g;

// One line with every unsafe character replaced, for names and labels.
export function safeLine(text: string): string {
  return text.replace(UNSAFE, "_");
}

// A file name to save as: one safe line without path separators.
export function safeFileName(name: string): string {
  return safeLine(name).replace(/[\\/]/g, "_") || "document";
}

// Multi-line text kept as lines: every kind of line break becomes "\n" followed by `indent`, so
// each continuation stays inside its block, and other unsafe characters are dropped.
export function safeIndentedText(text: string, indent: string): string {
  return text
    .split(LINE_BREAK)
    .map((line) => line.replace(UNSAFE, ""))
    .join(`\n${indent}`);
}
