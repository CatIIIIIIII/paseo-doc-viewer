import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Answer = { status: string; values?: unknown };
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const ready = (kindColors: unknown): Answer => ({ status: "ready", values: { kindColors } });

// The setting lives in module state shared by every panel and card, so each test loads a fresh copy.
async function freshSetting() {
  vi.resetModules();
  return (await import("../client/use-kind-colors")).kindColorsSetting;
}

describe("Color file types setting", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps the last value known when an answer is invalid or fails, and is on only while nothing is known", async () => {
    const setting = await freshSetting();
    const answers: (() => Promise<Answer>)[] = [
      async () => ({ status: "invalid" }),
      async () => ready(false),
      async () => ({ status: "invalid" }),
      async () => ready("off"),
      () => Promise.reject(new Error("offline")),
    ];
    const seen: boolean[] = [];
    for (const answer of answers) {
      setting.refresh(answer);
      await settle();
      seen.push(setting.get());
      vi.advanceTimersByTime(30_000);
    }
    expect(seen).toEqual([true, false, false, false, false]);
  });

  it("reads again at most every 30 s, including after a failed read", async () => {
    const setting = await freshSetting();
    const read = vi.fn(() => Promise.reject(new Error("offline")));
    setting.refresh(read);
    setting.refresh(read);
    await settle();
    vi.advanceTimersByTime(29_999);
    setting.refresh(read);
    expect(read).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    setting.refresh(read);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("tells listeners, and a read that started before a save does not undo it", async () => {
    const setting = await freshSetting();
    const heard: boolean[] = [];
    const stop = setting.subscribe((value) => heard.push(value));
    let answer!: (value: Answer) => void;
    setting.refresh(() => new Promise((resolve) => (answer = resolve)));
    setting.set(false);
    answer(ready(true));
    await settle();
    expect(setting.get()).toBe(false);
    vi.advanceTimersByTime(30_000);
    setting.refresh(async () => ready(true));
    await settle();
    stop();
    setting.set(false);
    expect(heard).toEqual([false, true]);
  });
});
