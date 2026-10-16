import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openDocument, readMediaChunk } from "../server/documents";
import { FIXTURES, PLUGIN_ROOT, workspaceWithFixtures } from "./helpers";

describe("S8: an agent-recorded mp4 plays in the app", () => {
  it("S8: doc.open identifies clip.mp4 as video/mp4 with its byte size", async () => {
    const root = workspaceWithFixtures("clip.mp4");
    const size = readFileSync(join(FIXTURES, "clip.mp4")).length;
    expect(await openDocument({ root, path: "clip.mp4" })).toMatchObject({ kind: "video", mimeType: "video/mp4", size });
  });

  it("S8: media.chunk streams the whole file in ranged chunks that reassemble byte for byte", async () => {
    const root = workspaceWithFixtures("clip.mp4");
    const original = readFileSync(join(FIXTURES, "clip.mp4"));
    const parts: Buffer[] = [];
    let offset: number | null = 0;
    for (let guard = 0; offset !== null && guard < 100; guard++) {
      const chunk = await readMediaChunk({ root, path: "clip.mp4" }, { offset, length: 1024 });
      expect(chunk.offset).toBe(offset);
      parts.push(Buffer.from(chunk.data, "base64"));
      offset = chunk.nextOffset;
    }
    expect(offset).toBeNull();
    expect(Buffer.concat(parts).equals(original)).toBe(true);
  });

  it("S8: native known limitation: the 0.11.2 plugin host exposes no video component to plugin clients", () => {
    const hostUi = ["react-native.d.ts", "ui.d.ts"].map((file) =>
      readFileSync(join(PLUGIN_ROOT, "node_modules/@getpaseo/plugin/dist/client", file), "utf8"),
    );
    expect(hostUi.some((source) => /\bVideo\b/.test(source))).toBe(false);
  });

  it.todo("S8: native iOS and Android play the mp4 in the viewer screen (blocked until the host exposes a video component)");
});
