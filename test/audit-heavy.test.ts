import { setTimeout as realDelay } from "node:timers/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderPdfPage } from "../server/pdf";
import { pdfium, pdfiumStats } from "../server/pdfium";
import { errorCode } from "../shared/errors";
import { textPdf } from "./fixtures/generators.ts";
import { nestedFormPdf } from "./fixtures/hostile";
import { workspace } from "./helpers";

// Audit (post 0.4.0): heavy() bounded the wait for a slot (20 s) and the work itself (20 s)
// separately, so one call could take ~40 s, past the host's 30 s plugin RPC timeout
// (packages/server/src/server/plugins/runtime.ts REQUEST_TIMEOUT_MS). The deadline also only
// stopped waiting: the slot was released while the timed-out work kept running (peak 4 of 2).
// Now one budget covers both, the deadline aborts the work, and the slot is held until it stops.

const HOST_RPC_TIMEOUT_MS = 30_000;

async function freshHeavy() {
  vi.resetModules();
  return (await import("../server/heavy")).heavy;
}

afterEach(() => vi.useRealTimers());

describe("audit: heavy() deadlines", () => {
  it("settles every call before the host RPC timeout, queue wait included", async () => {
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

  it("aborts timed-out work and keeps its slot until it stops", async () => {
    vi.useFakeTimers();
    const heavy = await freshHeavy();
    let running = 0;
    let peak = 0;
    const busyFor = (ms: number) => async (signal: AbortSignal) => {
      running++;
      peak = Math.max(peak, running);
      // Stops 500 ms after an abort, like work that checks its signal between steps.
      await new Promise<void>((resolve) => {
        const done = setTimeout(resolve, ms);
        signal.addEventListener("abort", () => {
          clearTimeout(done);
          setTimeout(resolve, 500);
        });
      });
      running--;
    };
    const first = [0, 1].map(() => heavy(busyFor(60_000)).catch(() => "timed out"));
    await vi.advanceTimersByTimeAsync(20_001);
    expect(await Promise.all(first)).toEqual(["timed out", "timed out"]);
    const second = [0, 1].map(() => heavy(busyFor(1_000)));
    await vi.advanceTimersByTimeAsync(10);
    expect(running).toBe(2);
    await vi.advanceTimersByTimeAsync(5_000);
    await Promise.all(second);
    expect(peak).toBe(2);
  });

  it("frees the slot of work that ignores the abort after a grace period", async () => {
    vi.useFakeTimers();
    const heavy = await freshHeavy();
    const hung = [0, 1].map(() => heavy(() => new Promise(() => {})).catch(() => "timed out"));
    await vi.advanceTimersByTimeAsync(20_001);
    expect(await Promise.all(hung)).toEqual(["timed out", "timed out"]);
    let startedAt = Number.NaN;
    const next = heavy(async () => {
      startedAt = Date.now();
      return "ran";
    });
    await vi.advanceTimersByTimeAsync(4_000);
    expect(startedAt).toBeNaN();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await next).toBe("ran");
  });

  it("stops the PDFium job of a call that ran out of time, so the next page renders", async () => {
    const root = workspace({ "slow.pdf": nestedFormPdf(9), "ok.pdf": await textPdf(["hello"]) });
    const file = (name: string) => ({ path: join(root, name), revision: "1", size: 4096, passwordKey: "" });
    await pdfium({ op: "open", key: "heavy-warm", bytes: await textPdf(["warm"]) });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const heavy = await freshHeavy();
    const spawns = pdfiumStats().spawns;
    const slow = heavy((signal) => renderPdfPage(file("slow.pdf"), 0, { maxWidth: 800, maxBytes: 6_000_000 }, signal)).catch((error) => error);
    // The worker calls start 5 s into the budget, so their own 20 s timers cannot fire first. Let
    // the open and the render reach the worker, then run out the call's budget.
    await vi.advanceTimersByTimeAsync(5_000);
    await realDelay(300);
    await vi.advanceTimersByTimeAsync(15_001);
    expect(errorCode(await slow)).toBe("timeout");
    vi.useRealTimers();
    const started = performance.now();
    const ok = await renderPdfPage(file("ok.pdf"), 0, { maxWidth: 400, maxBytes: 6_000_000 });
    expect(ok.image.width).toBe(400);
    // The aborted render did not keep the worker busy: a new worker served the next page at once.
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(pdfiumStats().spawns).toBe(spawns + 1);
  }, 30_000);
});
