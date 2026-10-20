import { ERROR_MESSAGES } from "../shared/errors";
import { RPC_DEADLINE_MS } from "../shared/limits";

// Thumbnails share one background slot and start only when no foreground work waits. Page map
// thumbnails ("background") go before thumbnails of files nobody is reading ("idle"), such as a
// turn card's, so a timeline of cards cannot starve the grid open on screen.
export type Lane = "foreground" | "background" | "idle";

const MAX_CONCURRENT = 2;
const MAX_BACKGROUND = 1;
const MAX_LANE_WAITING = 8;
// Background work stops waiting with half its budget left, so work that starts has time to finish.
const BACKGROUND_WAIT_MS = RPC_DEADLINE_MS / 2;
// Work that ignores its abort signal keeps its slot this much longer, then stops counting, so a
// call that never settles cannot hold a slot forever.
export const ABANDON_GRACE_MS = 5_000;

interface Slot {
  start: () => void;
  timer: ReturnType<typeof setTimeout>;
}

let active = 0;
let background = 0;
const waiting: Record<Lane, Slot[]> = { foreground: [], background: [], idle: [] };

function enqueue(queue: Slot[], waitMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const slot: Slot = {
      start: () => {
        clearTimeout(slot.timer);
        resolve();
      },
      timer: setTimeout(() => {
        queue.splice(queue.indexOf(slot), 1);
        reject(new Error(ERROR_MESSAGES.busy()));
      }, waitMs),
    };
    queue.push(slot);
  });
}

function acquire(lane: Lane): Promise<void> {
  if (lane === "foreground") {
    if (active >= MAX_CONCURRENT) return enqueue(waiting.foreground, RPC_DEADLINE_MS);
    active++;
    return Promise.resolve();
  }
  if (active < MAX_CONCURRENT && background < MAX_BACKGROUND && waiting.foreground.length === 0) {
    active++;
    background++;
    return Promise.resolve();
  }
  if (waiting[lane].length >= MAX_LANE_WAITING) return Promise.reject(new Error(ERROR_MESSAGES.busy()));
  return enqueue(waiting[lane], BACKGROUND_WAIT_MS);
}

function release(lane: Lane): void {
  active--;
  if (lane !== "foreground") background--;
  const foreground = waiting.foreground.shift();
  if (foreground) {
    active++;
    foreground.start();
    return;
  }
  if (background >= MAX_BACKGROUND) return;
  const next = waiting.background.shift() ?? waiting.idle.shift();
  if (!next) return;
  active++;
  background++;
  next.start();
}

// One budget covers the wait for a slot and the work, so a call settles within RPC_DEADLINE_MS,
// before the host's 30 s RPC timeout. At the deadline the work's signal aborts; its slot is freed
// when the work stops (or after ABANDON_GRACE_MS), so timed-out work never runs beside a full
// set of new work.
export async function heavy<T>(work: (signal: AbortSignal) => Promise<T>, { lane = "foreground" }: { lane?: Lane } = {}): Promise<T> {
  const deadline = Date.now() + RPC_DEADLINE_MS;
  await acquire(lane);
  let freed = false;
  const free = () => {
    if (freed) return;
    freed = true;
    release(lane);
  };
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(ERROR_MESSAGES.tooSlow()));
    }, Math.max(0, deadline - Date.now()));
  });
  const running = (async () => work(controller.signal))();
  running.then(free, free);
  try {
    return await Promise.race([running, expired]);
  } finally {
    clearTimeout(timer);
    if (controller.signal.aborted) setTimeout(free, ABANDON_GRACE_MS);
  }
}
