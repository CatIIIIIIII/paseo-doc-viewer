import { describe, expect, it } from "vitest";
import { absoluteTime } from "../client/format";
import { DETAILS_FOLDER_MIN_WIDTH, detailsColumns } from "../client/panel-layout";

describe("Details columns", () => {
  it("gives the folder its own column only from 640 pt, and drops the size where it does not fit", () => {
    expect(detailsColumns(DETAILS_FOLDER_MIN_WIDTH, false)).toMatchObject({ folder: "column", size: true, time: "long", rowHeight: 28 });
    expect(detailsColumns(DETAILS_FOLDER_MIN_WIDTH - 1, false)).toMatchObject({ folder: "inline", size: true, time: "short" });
    expect(detailsColumns(280, false)).toMatchObject({ folder: "inline", size: false, time: "short" });
  });

  it("keeps 44 pt rows on a phone, with the folder after the name and no size", () => {
    expect(detailsColumns(1024, true)).toMatchObject({ folder: "inline", size: false, time: "short", rowHeight: 44, iconSize: 16, nameSize: 14 });
  });
});

describe("absolute times", () => {
  const now = new Date(2026, 9, 19, 15, 0).getTime();
  it("shows the clock today, the day before as Yesterday, then the date", () => {
    expect(absoluteTime(new Date(2026, 9, 19, 9, 5).getTime(), now)).toBe("09:05");
    expect(absoluteTime(new Date(2026, 9, 18, 18, 40).getTime(), now)).toBe("Yesterday 18:40");
    expect(absoluteTime(new Date(2026, 9, 18, 18, 40).getTime(), now, "short")).toBe("Yesterday");
    expect(absoluteTime(new Date(2026, 9, 17, 23, 59).getTime(), now)).toBe("17 Oct");
    expect(absoluteTime(new Date(2025, 8, 2, 12, 0).getTime(), now)).toBe("2025-09-02");
    expect(absoluteTime(now + 60_000, now)).toBe("15:01");
  });
});
