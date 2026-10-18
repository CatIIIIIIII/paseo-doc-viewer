import { decodeEntities } from "./html";

export const MAX_COLUMN = 16_384;
export const MAX_ROW = 1_048_576;
const MAX_SHARED_FORMULA_CHARS = 4 * 1024 * 1024;
const CELL_REFERENCE = /^(\$?)([A-Za-z]{1,3})(\$?)(\d{1,7})(?![\p{L}\p{N}_.(!\\?])/u;
const IDENTIFIER = /^[\p{L}_\\][\p{L}\p{N}_.\\?]*/u;
const NUMBER = /^(?:\d+\.?\d*|\.\d+)(?:E[+-]?\d+)?/i;

export function columnLetters(index: number): string {
  let name = "";
  for (let remaining = index + 1; remaining > 0; remaining = Math.floor((remaining - 1) / 26)) {
    name = String.fromCharCode(65 + ((remaining - 1) % 26)) + name;
  }
  return name;
}

export const cellAddress = (row: number, column: number) => `${columnLetters(column)}${row + 1}`;

function columnNumber(letters: string): number {
  let column = 0;
  for (const char of letters.toUpperCase()) column = column * 26 + (char.charCodeAt(0) - 64);
  return column;
}

function closing(text: string, from: number, quote: string): number {
  for (let at = from; ; at += 2) {
    at = text.indexOf(quote, at);
    if (at < 0 || text[at + 1] !== quote) return at;
  }
}

// Moves the relative references of a shared formula's master text to another cell of its range,
// as Excel does. Returns null for any construct it cannot shift with certainty.
export function shiftFormula(text: string, rows: number, columns: number): string | null {
  let out = "";
  let at = 0;
  while (at < text.length) {
    const rest = text.slice(at);
    const char = text[at]!;
    if (char === '"' || char === "'") {
      const end = closing(text, at + 1, char);
      if (end < 0 || (char === "'" && text[end + 1] !== "!")) return null;
      out += text.slice(at, end + 1);
      at = end + 1;
      continue;
    }
    if (char === "[") return null;
    const number = /^[\d.]/.test(char) ? NUMBER.exec(rest) : null;
    if (number) {
      if (text[at + number[0].length] === ":") return null;
      out += number[0];
      at += number[0].length;
      continue;
    }
    const reference = CELL_REFERENCE.exec(rest);
    if (reference) {
      const [whole, columnFixed, letters, rowFixed, digits] = reference;
      const column = columnNumber(letters!) + (columnFixed ? 0 : columns);
      const row = Number(digits) + (rowFixed ? 0 : rows);
      if (column < 1 || column > MAX_COLUMN || row < 1 || row > MAX_ROW) return null;
      out += `${columnFixed}${columnLetters(column - 1)}${rowFixed}${row}`;
      at += whole.length;
      continue;
    }
    if (char === "$") return null;
    const identifier = IDENTIFIER.exec(rest);
    if (identifier) {
      if (text[at + identifier[0].length] === ":") return null;
      out += identifier[0];
      at += identifier[0].length;
      continue;
    }
    out += char;
    at++;
  }
  return out;
}

interface SharedMaster {
  row: number;
  column: number;
  text: string;
  range: string;
}

// Collects shared-formula master cells while a sheet streams, so a later cell of the group can be resolved.
export class SharedFormulas {
  private readonly masters = new Map<string, SharedMaster>();
  private chars = 0;

  observe(cell: string, row: number, column: number): void {
    if (!cell.includes('t="shared"')) return;
    const formula = /<f\b([^<>]*)>([^<]+)<\/f>/.exec(cell);
    const group = formula && /\ssi="(\d+)"/.exec(formula[1]!)?.[1];
    const range = formula && /\sref="([^"]+)"/.exec(formula[1]!)?.[1];
    if (!formula || !group || !range || this.masters.has(group)) return;
    const text = decodeEntities(formula[2]!);
    if (this.chars + text.length > MAX_SHARED_FORMULA_CHARS) return;
    this.chars += text.length;
    this.masters.set(group, { row, column, text, range });
  }

  master(group: string): SharedMaster | undefined {
    return this.masters.get(group);
  }
}
