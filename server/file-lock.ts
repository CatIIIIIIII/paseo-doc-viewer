import { open, rm, stat } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { ERROR_MESSAGES } from "../shared/errors";

// Writes hold a lock for milliseconds; an older lock was left by a process that died.
const STALE_LOCK_MS = 10_000;
const LOCK_WAIT_MS = 5_000;

// Runs `run` holding the lock file, so stores in other processes sharing a folder take turns.
export async function withFileLock<T>(lock: string, run: () => Promise<T>): Promise<T> {
  const started = Date.now();
  for (;;) {
    try {
      await (await open(lock, "wx", 0o600)).close();
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const age = await stat(lock).then((info) => Date.now() - info.mtimeMs, () => 0);
    if (age > STALE_LOCK_MS) await rm(lock, { force: true });
    else if (Date.now() - started > LOCK_WAIT_MS) throw new Error(ERROR_MESSAGES.busy());
    else await delay(5 + Math.random() * 20);
  }
  try {
    return await run();
  } finally {
    await rm(lock, { force: true });
  }
}
