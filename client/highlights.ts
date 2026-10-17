import type { SearchMatch, SearchNavigation } from "../shared/search";

export interface PageHighlight {
  boxes: NonNullable<SearchMatch["boxes"]>;
  selected: boolean;
}

// The find matches that land on the page being shown, ready to overlay on the rendered page.
export function pageHighlights(matches: readonly SearchMatch[], page: number, navigation: SearchNavigation | null): PageHighlight[] {
  const selectedPage = navigation?.target.type === "page" ? navigation.target.index : null;
  const highlights: PageHighlight[] = [];
  for (const match of matches) {
    if (match.target.type !== "page" || match.target.index !== page || !match.boxes?.length) continue;
    highlights.push({ boxes: match.boxes, selected: selectedPage === page && navigation?.start === match.start });
  }
  return highlights;
}
