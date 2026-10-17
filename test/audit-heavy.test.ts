import { afterEach, describe, expect, it, vi } from "vitest";
import { errorCode } from "../shared/errors";

// Audit (post 0.4.0): heavy() bounds the wait for a slot (20 s) and the work itself (20 s)
// separately, so one call can take ~40 s, past the host's 30 s plugin RPC timeout
// (packages/server/src/server/plugins/runtime.ts REQUEST_TIMEOUT_MS). The deadline also only
// stops waiting: the slot is released while the timed-out work keeps running.

const HOST_RPC_TIMEOUT_MS = 30_000;

async function freshHeavy() {
  vi.resetModules();
  return (await import("../server/heavy")).heavy;
}

afterEach(() => vi.useRealTimers());

describe("audit: heavy() deadlines", () => {
  it.fails("settles every call before the host RPC timeout (currently ~39 s for a queued call)", async () => {
    vi.useFakeTimers();
    const heavy = await freshHeavy();
    const hung = [0, 1].map(() => heavy(() => new Promise(() => {})).catch((error) => error));
    await vi.advanceTimersByTimeAsync(1_000);
    const started = Date.now();
    let settledAt = Number.NaN;
    const queued = heavy(() => new Promise(() => {})).catch((error) => {
      settledAt = Date.now();
      return error;
    });
    await vi.advanceTimersByTimeAsync(45_000);
    await Promise.all(hung);
    expect(errorCode(await queued)).toBe("timeout");
    expect(settledAt - started).toBeLessThan(HOST_RPC_TIMEOUT_MS);
  });

  it("releases the slot on timeout while the timed-out work keeps running (documents current behaviour)", async () => {
    vi.useFakeTimers();
    const heavy = await freshHeavy();
    let running = 0;
    let peak = 0;
    const busyFor = (ms: number) => async () => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, ms));
      running--;
    };
    const first = [0, 1].map(() => heavy(busyFor(60_000)).catch(() => "timed out"));
    await vi.advanceTimersByTimeAsync(20_001);
    expect(await Promise.all(first)).toEqual(["timed out", "timed out"]);
    const second = [0, 1].map(() => heavy(busyFor(1_000)));
    await vi.advanceTimersByTimeAsync(10);
    // MAX_CONCURRENT is 2, yet four pieces of work run at once.
    expect(peak).toBe(4);
    await vi.advanceTimersByTimeAsync(60_000);
    await Promise.all(second);
  });
});
