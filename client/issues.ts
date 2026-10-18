import type { DocIssuesOutput } from "../shared/rpc";
import { cellReference } from "./cell-detail";
import { formatCount } from "./format";

export type SheetIssue = DocIssuesOutput["issues"][number];
export type InspectedRange = DocIssuesOutput["inspected"][number];

export function mergeInspected(previous: readonly InspectedRange[], next: readonly InspectedRange[]): InspectedRange[] {
  const merged = [...previous];
  for (const range of next) {
    const last = merged[merged.length - 1];
    if (last && last.sheet === range.sheet && last.toRow === range.fromRow) merged[merged.length - 1] = { ...last, toRow: range.toRow };
    else merged.push(range);
  }
  return merged;
}

const sheetName = (names: readonly string[], sheet: number) => names[sheet] || `Sheet ${sheet + 1}`;

export function coverageText(inspected: readonly InspectedRange[], names: readonly string[]): string {
  if (inspected.length === 0) return "Nothing inspected yet.";
  const parts = inspected.map(({ sheet, fromRow, toRow }) =>
    toRow <= fromRow ? `${sheetName(names, sheet)} (no rows)` : `${sheetName(names, sheet)} rows ${formatCount(fromRow + 1)}-${formatCount(toRow)}`);
  return `Inspected ${parts.join(", ")}.`;
}

const PAUSE_REASONS: { readonly [K in NonNullable<DocIssuesOutput["stopped"]>]: string } = {
  time: "the time limit",
  rows: "the row limit",
  issues: "the issue limit",
};

export function pausedText(reason: NonNullable<DocIssuesOutput["stopped"]>, next: { sheet: number; row: number; column: number }, names: readonly string[]): string {
  const where = next.column > 0
    ? `at ${cellReference(sheetName(names, next.sheet), next.row, next.column)}`
    : `before ${sheetName(names, next.sheet)} row ${formatCount(next.row + 1)}`;
  return `Paused at ${PAUSE_REASONS[reason]}, ${where}.`;
}

const FORMULA_PREVIEW_CHARS = 60;

export function issueLabel(issue: SheetIssue, names: readonly string[]): string {
  if (issue.line !== undefined) return `Line ${formatCount(issue.line)}: ${issue.display}`;
  const at = cellReference(sheetName(names, issue.sheet), issue.row, issue.column);
  const what = issue.kind === "error" ? issue.display : "no saved result";
  if (issue.formula === null) return `${at}: ${what}`;
  const formula = issue.formula.length > FORMULA_PREVIEW_CHARS ? `${issue.formula.slice(0, FORMULA_PREVIEW_CHARS - 1)}…` : issue.formula;
  return `${at}: ${what} · =${formula}`;
}

// JSON Lines issues: unreadable lines and keys first seen after the column sample.
export function dataIssueSummary(issues: readonly SheetIssue[], omitted = 0): string {
  const invalid = issues.filter((issue) => issue.kind === "invalid-json").length + omitted;
  const unlisted = issues.filter((issue) => issue.kind === "unlisted-key").length;
  if (invalid === 0 && unlisted === 0) return "Every line is valid JSON";
  const parts = [];
  if (invalid) parts.push(`${formatCount(invalid)} invalid ${invalid === 1 ? "line" : "lines"}`);
  if (unlisted) parts.push(`${formatCount(unlisted)} ${unlisted === 1 ? "key" : "keys"} without a column`);
  return parts.join(", ");
}

export function issueSummary(issues: readonly SheetIssue[]): string {
  const errors = issues.filter((issue) => issue.kind === "error").length;
  const missing = issues.length - errors;
  if (issues.length === 0) return "No error cells or formulas without a saved result";
  const parts = [];
  if (errors) parts.push(`${formatCount(errors)} error ${errors === 1 ? "cell" : "cells"}`);
  if (missing) parts.push(`${formatCount(missing)} ${missing === 1 ? "formula" : "formulas"} without a saved result`);
  return parts.join(", ");
}
