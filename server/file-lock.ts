import { open, rm, stat } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { ERROR_MESSAGES } from "../shared/errors";

// Writes hold a lock for milliseconds; an older lock was left by a process that died.
const STALE_LOCK_MS = 10_000;
const LOCK_WAIT_MS = 5_000;
// A lock stamped later than now is not from a live writer either: the clock was set back, or the file came
// from a machine whose clock was ahead. A file system can stamp a millisecond or so ahead, hence the slack.
const CLOCK_SKEW_MS = 1_000;
const RELEASE_TRIES = 5;

// Creating the file is taking the lock; EEXIST means another holds it.
async function create(file: string): Promise<boolean> {
  try {
    await (await open(file, "wx", 0o600)).close();
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
}

// A file that is gone is not stale: it was just released.
async function isStale(file: string): Promise<boolean> {
  const info = await stat(file).catch(() => null);
  if (!info) return false;
  const age = Date.now() - info.mtimeMs;
  return age > STALE_LOCK_MS || age < -CLOCK_SKEW_MS;
}

// Never throws: a failed release must not replace what `run` returned or threw. A file left behind
// goes stale, and the next writer takes it over. `rm` ignores maxRetries unless it is recursive.
async function release(file: string): Promise<void> {
  for (let attempt = 1; attempt <= RELEASE_TRIES; attempt++) {
    try {
      return await rm(file, { force: true });
    } catch {
      if (attempt < RELEASE_TRIES) await delay(10 * attempt);
    }
  }
}

// Removes a stale lock for the waiters that saw it. Two of them removing it one after the other would
// delete a lock a third had made in between, so only the holder of a guard file removes it, and only
// if it is still stale then. Returns false when another has the guard.
async function takeOver(lock: string): Promise<boolean> {
  const guard = `${lock}.takeover`;
  if (!(await create(guard))) {
    if (await isStale(guard)) await release(guard);
    return false;
  }
  try {
    if (await isStale(lock)) await rm(lock, { force: true });
  } finally {
    await release(guard);
  }
  return true;
}

// Runs `run` holding the lock file, so stores in other processes sharing a folder take turns.
export async function withFileLock<T>(lock: string, run: () => Promise<T>): Promise<T> {
  const started = Date.now();
  while (!(await create(lock))) {
    if (Date.now() - started > LOCK_WAIT_MS) throw new Error(ERROR_MESSAGES.busy());
    if ((await isStale(lock)) && (await takeOver(lock))) continue;
    await delay(5 + Math.random() * 20);
  }
  try {
    return await run();
  } finally {
    await release(lock);
  }
}
