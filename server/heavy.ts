import { ERROR_MESSAGES } from "../shared/errors";
import { RPC_DEADLINE_MS } from "../shared/limits";

const MAX_CONCURRENT = 2;
const MAX_BACKGROUND = 1;
const MAX_BACKGROUND_WAITING = 8;
const MAX_QUEUE_WAIT_MS = 20_000;

interface Slot {
  start: () => void;
  timer: ReturnType<typeof setTimeout>;
}

let active = 0;
let background = 0;
const waiting: Slot[] = [];
const waitingBackground: Slot[] = [];

function enqueue(queue: Slot[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const slot: Slot = {
      start: () => {
        clearTimeout(slot.timer);
        resolve();
      },
      timer: setTimeout(() => {
        queue.splice(queue.indexOf(slot), 1);
        reject(new Error(ERROR_MESSAGES.busy()));
      }, MAX_QUEUE_WAIT_MS),
    };
    queue.push(slot);
  });
}

// Background work (thumbnails) holds at most one slot and starts only when no foreground work waits.
function acquire(isBackground: boolean): Promise<void> {
  if (!isBackground) {
    if (active >= MAX_CONCURRENT) return enqueue(waiting);
    active++;
    return Promise.resolve();
  }
  if (active < MAX_CONCURRENT && background < MAX_BACKGROUND && waiting.length === 0) {
    active++;
    background++;
    return Promise.resolve();
  }
  if (waitingBackground.length >= MAX_BACKGROUND_WAITING) return Promise.reject(new Error(ERROR_MESSAGES.busy()));
  return enqueue(waitingBackground);
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

export async function heavy<T>(work: () => Promise<T>, { background: isBackground = false } = {}): Promise<T> {
  await acquire(isBackground);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(ERROR_MESSAGES.tooSlow())), RPC_DEADLINE_MS);
  });
  try {
    return await Promise.race([work(), deadline]);
  } finally {
    clearTimeout(timer);
    release(isBackground);
  }
}
