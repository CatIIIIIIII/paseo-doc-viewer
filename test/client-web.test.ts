import { afterEach, describe, expect, it, vi } from "vitest";

async function webModule(os: string) {
  vi.resetModules();
  vi.doMock("react-native", () => ({ Platform: { OS: os } }));
  return import("../client/web");
}

afterEach(() => {
  vi.doUnmock("react-native");
});

describe("video playback gate", () => {
  it("plays video only in the web runtime, which desktop also uses", async () => {
    expect((await webModule("web")).canPlayMedia).toBe(true);
    expect((await webModule("ios")).canPlayMedia).toBe(false);
    expect((await webModule("android")).canPlayMedia).toBe(false);
  });

  it("creates no object URL and renders no video element on native", async () => {
    const native = await webModule("ios");
    expect(native.createMediaUrl([new Uint8Array([1])], "video/mp4")).toBeNull();
    expect(native.MediaElement({ uri: "blob:x", label: "clip", background: "#000" })).toBeNull();
  });

  it("renders a video element on web", async () => {
    const web = await webModule("web");
    const element = web.MediaElement({ uri: "blob:x", label: "clip", background: "#000" });
    expect(element?.type).toBe("video");
    expect(element?.props).toMatchObject({ src: "blob:x", controls: true });
  });
});

describe("window focus", () => {
  it("calls the listener when the web window gets focus until it is removed, and never on native", async () => {
    const listeners = new Set<() => void>();
    vi.stubGlobal("window", {
      addEventListener: (type: string, listener: () => void) => type === "focus" && listeners.add(listener),
      removeEventListener: (type: string, listener: () => void) => type === "focus" && listeners.delete(listener),
    });
    try {
      const listener = vi.fn();
      const stop = (await webModule("web")).onWindowFocus(listener);
      for (const each of listeners) each();
      expect(listener).toHaveBeenCalledTimes(1);
      stop();
      expect(listeners.size).toBe(0);
      (await webModule("ios")).onWindowFocus(listener)();
      expect(listeners.size).toBe(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
