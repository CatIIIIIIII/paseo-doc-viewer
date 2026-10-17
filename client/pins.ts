import type { PagePin } from "../shared/viewer-state";

export type PinStatus = "current" | "changed" | "missing";

// Page numbers cannot follow inserted or deleted pages, so any rewrite asks the user to check the pin.
export function pinStatus(pin: PagePin, revision: string, count: number): PinStatus {
  if (pin.index >= count) return "missing";
  return pin.revision === revision ? "current" : "changed";
}
