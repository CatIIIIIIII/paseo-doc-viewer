// First-run tips at the top of Documents, one at a time. The server keeps only whether they were
// dismissed; which tip is showing lives in the panel, so after Skip or Done a reload keeps them hidden.

export interface Tip {
  title: string;
  text: string;
}

export const TIPS: readonly Tip[] = [
  { title: "Open documents", text: "Open Documents from the new tab menu, including on a phone. In a chat, /doc opens the latest document, or a path you give." },
  { title: "Review a PDF", text: "Pin pages and add notes as you read, then send all notes to an agent as one review from Review notes." },
  { title: "See what is new", text: "The New filter shows files that changed since your last visit. Opening a file clears its New label until it changes again." },
  { title: "After each turn", text: "A chat card lists changed documents. Its Settings link (gear icon on a phone) opens the option to turn cards off." },
];

// What was pressed in this panel: nothing yet (follow the server), a tip to show, or closed.
export type TipsChoice = { step: number } | "closed" | null;

// The tip to show, or null. Nothing shows until the server answers, so dismissed tips never flash.
export function visibleTip(dismissed: boolean | undefined, choice: TipsChoice): number | null {
  if (choice === "closed") return null;
  if (choice !== null) return choice.step;
  return dismissed === false ? 0 : null;
}

// Next moves on; on the last tip it finishes, which dismisses the tips like Skip does.
export function afterNext(step: number): { choice: TipsChoice; dismiss: boolean } {
  return step + 1 < TIPS.length ? { choice: { step: step + 1 }, dismiss: false } : { choice: "closed", dismiss: true };
}

export function tipControls(step: number): { progress: string; next: "Next" | "Done"; skip: boolean } {
  const last = step >= TIPS.length - 1;
  return { progress: `${step + 1} of ${TIPS.length}`, next: last ? "Done" : "Next", skip: !last };
}
