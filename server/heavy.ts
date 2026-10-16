import { ERROR_MESSAGES } from "../shared/errors";

const MAX_CONCURRENT = 2;
const MAX_QUEUE_WAIT_MS = 20_000;

let active = 0;
const waiting: { start: () => void; timer: ReturnType<typeof setTimeout> }[] = [];

function acquire(): Promise<void> {
  if (active < MAX_CONCURRENT) {
    active++;
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const slot = {
      start: () => {
        clearTimeout(slot.timer);
        resolve();
      },
      timer: setTimeout(() => {
        waiting.splice(waiting.indexOf(slot), 1);
        reject(new Error(ERROR_MESSAGES.busy()));
      }, MAX_QUEUE_WAIT_MS),
    };
    waiting.push(slot);
  });
}

function release(): void {
  const next = waiting.shift();
  if (next) next.start();
  else active--;
}

export async function heavy<T>(work: () => Promise<T>): Promise<T> {
  await acquire();
  try {
    return await work();
  } finally {
    release();
  }
}
