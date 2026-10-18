import { ERROR_MESSAGES } from "../shared/errors";
import { RPC_DEADLINE_MS } from "../shared/limits";

const MAX_CONCURRENT = 2;
const MAX_BACKGROUND = 1;
const MAX_BACKGROUND_WAITING = 8;
// Work that ignores its abort signal keeps its slot this much longer, then stops counting, so a
// call that never settles cannot hold a slot forever.
export const ABANDON_GRACE_MS = 5_000;

interface Slot {
  start: () => void;
  timer: ReturnType<typeof setTimeout>;
}

let active = 0;
let background = 0;
const waiting: Slot[] = [];
const waitingBackground: Slot[] = [];

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

// Background work (thumbnails) holds at most one slot and starts only when no foreground work waits.
function acquire(isBackground: boolean, waitMs: number): Promise<void> {
  if (!isBackground) {
    if (active >= MAX_CONCURRENT) return enqueue(waiting, waitMs);
    active++;
    return Promise.resolve();
  }
  if (active < MAX_CONCURRENT && background < MAX_BACKGROUND && waiting.length === 0) {
    active++;
    background++;
    return Promise.resolve();
  }
  if (waitingBackground.length >= MAX_BACKGROUND_WAITING) return Promise.reject(new Error(ERROR_MESSAGES.busy()));
  return enqueue(waitingBackground, waitMs);
}

function release(isBackground: boolean): void {
  active--;
  if (isBackground) background--;
  const foreground = waiting.shift();
  if (foreground) {
    active++;
    foreground.start();
    return;
  }
  if (background >= MAX_BACKGROUND) return;
  const next = waitingBackground.shift();
  if (!next) return;
  active++;
  background++;
  next.start();
}

// One budget covers the wait for a slot and the work, so a call settles within RPC_DEADLINE_MS,
// before the host's 30 s RPC timeout. At the deadline the work's signal aborts; its slot is freed
// when the work stops (or after ABANDON_GRACE_MS), so timed-out work never runs beside a full
// set of new work.
export async function heavy<T>(work: (signal: AbortSignal) => Promise<T>, { background: isBackground = false } = {}): Promise<T> {
  const deadline = Date.now() + RPC_DEADLINE_MS;
  await acquire(isBackground, RPC_DEADLINE_MS);
  let freed = false;
  const free = () => {
    if (freed) return;
    freed = true;
    release(isBackground);
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
