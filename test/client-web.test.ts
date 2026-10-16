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
    expect((await webModule("web")).canPlayVideo).toBe(true);
    expect((await webModule("ios")).canPlayVideo).toBe(false);
    expect((await webModule("android")).canPlayVideo).toBe(false);
  });

  it("creates no object URL and renders no video element on native", async () => {
    const native = await webModule("ios");
    expect(native.createMediaUrl([new Uint8Array([1])], "video/mp4")).toBeNull();
    expect(native.VideoElement({ uri: "blob:x", label: "clip", background: "#000" })).toBeNull();
  });

  it("renders a video element on web", async () => {
    const web = await webModule("web");
    const element = web.VideoElement({ uri: "blob:x", label: "clip", background: "#000" });
    expect(element?.type).toBe("video");
    expect(element?.props).toMatchObject({ src: "blob:x", controls: true });
  });
});
