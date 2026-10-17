import { describe, expect, it } from "vitest";
import { openDocument, readMediaChunk, listRecent } from "../server/documents";
import { detectKind } from "../shared/kinds";
import { workspace } from "./helpers";

function wav() {
  const bytes = Buffer.alloc(44 + 800);
  bytes.write("RIFF", 0); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write("WAVEfmt ", 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(8000, 24); bytes.writeUInt32LE(16000, 28); bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34); bytes.write("data", 36); bytes.writeUInt32LE(800, 40);
  for (let i = 0; i < 400; i++) bytes.writeInt16LE(Math.round(Math.sin(i * 2 * Math.PI * 440 / 8000) * 8000), 44 + i * 2);
  return bytes;
}

describe("standalone audio", () => {
  it("discovers audio-only workspaces and transfers original WAV samples exactly", async () => {
    const bytes = wav();
    const root = workspace({ "tone.wav": bytes });
    const opened = await openDocument({ root, path: "tone.wav" });
    expect(opened).toMatchObject({ kind: "audio", mimeType: "audio/wav", size: bytes.length });
    const listing = await listRecent(root, {});
    expect(listing.counts.audio).toBe(1);
    const parts: Buffer[] = [];
    let offset: number | null = 0;
    while (offset !== null) {
      const chunk = await readMediaChunk({ root, path: "tone.wav" }, { offset, length: 127 });
      expect(chunk.kind).toBe("audio");
      parts.push(Buffer.from(chunk.data, "base64"));
      offset = chunk.nextOffset;
    }
    expect(Buffer.concat(parts)).toEqual(bytes);
  });

  it("checks the actual audio container rather than trusting the extension", () => {
    expect(detectKind("a.wav", Buffer.from("RIFF1234AVI "))).toBeNull();
    expect(detectKind("a.mp3", Buffer.from("fLaC"))).toBeNull();
    expect(detectKind("a.wav", wav())).toBe("audio");
    expect(detectKind("a.flac", Buffer.from("fLaC"))).toBe("audio");
    expect(detectKind("a.m4a", Buffer.from("0000ftypM4A "))).toBe("audio");
    expect(detectKind("a.mp3", Buffer.from("ID3"))).toBe("audio");
    expect(detectKind("a.mp3", Uint8Array.from([0xff, 0xfb, 0x90, 0]))).toBe("audio");
    expect(detectKind("a.mp3", Uint8Array.from([0xff, 0xff, 0xff, 0xff]))).toBeNull();
  });
});
