import { literalPattern, type SearchCursor, type SearchMatch, type SearchTarget } from "../shared/search";

export const SEARCH_BUDGET_MS = 3_500;
export const SEARCH_MAX_MATCHES = 50;
const YIELD_EVERY_MS = 40;
const STREAM_IDLE_MS = 60_000;
const MAX_PARKED_STREAMS = 8;

export type SearchPosition = Pick<SearchCursor, "sheet" | "unit" | "column">;

export const position = (sheet: number, unit: number, column = 0): SearchPosition => ({ sheet, unit, column });

// Visits text in document order within one call's time budget and records where the next call resumes.
export class SearchScan {
  readonly matches: SearchMatch[] = [];
  next: SearchCursor | null = null;
  scanned = 0;
  private readonly pattern: RegExp;
  private yielded = Date.now();

  constructor(private readonly cursor: SearchCursor, private readonly deadline: number) {
    this.pattern = literalPattern(cursor.query);
  }

  // Cached content resolves without I/O, so a long scan would otherwise hold the event loop for the whole budget.
  async breathe(): Promise<void> {
    if (Date.now() - this.yielded < YIELD_EVERY_MS) return;
    await new Promise((resume) => setImmediate(resume));
    this.yielded = Date.now();
  }

  // Positions before the cursor must already be skipped by the caller.
  visit(text: string, target: SearchTarget, at: SearchPosition, after: SearchPosition): boolean {
    this.scanned++;
    const { pattern, cursor } = this;
    const resumes = at.sheet === cursor.sheet && at.unit === cursor.unit && at.column === cursor.column;
    pattern.lastIndex = resumes ? cursor.offset : 0;
    for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
      this.matches.push({
        target,
        start: match.index,
        length: match[0].length,
        snippet: text.slice(Math.max(0, match.index - 45), match.index + match[0].length + 65),
      });
      if (this.matches.length === SEARCH_MAX_MATCHES) {
        this.next = { ...cursor, ...at, offset: pattern.lastIndex };
        return false;
      }
    }
    if (Date.now() < this.deadline) return true;
    this.next = { ...cursor, ...after, offset: 0 };
    return false;
  }
}

// A row stream that can be parked between calls, so a long sheet is parsed once per search.
export class RowStream<Row extends { row: number }> {
  private head: Row | null = null;
  constructor(private readonly source: AsyncIterator<Row>) {}

  canResume(fromRow: number): boolean {
    return this.head !== null && this.head.row <= fromRow;
  }

  async *from(fromRow: number): AsyncGenerator<Row> {
    if (this.head && this.head.row >= fromRow) yield this.head;
    for (;;) {
      const next = await this.source.next();
      if (next.done) {
        this.head = null;
        return;
      }
      this.head = next.value;
      if (next.value.row >= fromRow) yield next.value;
    }
  }

  get exhausted(): boolean {
    return this.head === null;
  }

  close(): void {
    void this.source.return?.(undefined);
  }
}

const parked = new Map<string, { stream: RowStream<{ row: number }>; timer: ReturnType<typeof setTimeout> }>();

export function takeStream<Row extends { row: number }>(key: string, fromRow: number, open: () => AsyncIterator<Row>): RowStream<Row> {
  const entry = parked.get(key);
  if (entry) {
    parked.delete(key);
    clearTimeout(entry.timer);
    if (entry.stream.canResume(fromRow)) return entry.stream as RowStream<Row>;
    entry.stream.close();
  }
  return new RowStream(open());
}

export function parkStream(key: string, stream: RowStream<{ row: number }>): void {
  if (stream.exhausted) return stream.close();
  parked.get(key)?.stream.close();
  parked.delete(key);
  const timer = setTimeout(() => {
    if (parked.get(key)?.stream === stream) parked.delete(key);
    stream.close();
  }, STREAM_IDLE_MS);
  (timer as unknown as NodeJS.Timeout).unref();
  parked.set(key, { stream, timer });
  for (const [oldest, value] of parked) {
    if (parked.size <= MAX_PARKED_STREAMS) break;
    clearTimeout(value.timer);
    value.stream.close();
    parked.delete(oldest);
  }
}
