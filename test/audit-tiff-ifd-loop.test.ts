import { describe, expect, it } from "vitest";
import { imageSize } from "../server/images";
import { assertTiffStructure } from "../server/tiff";
import { pluginModule, runCapped } from "./capped-child";
import { selfReferentialTiff, tiffWithEntries } from "./fixtures/hostile";

// Audit (post 0.4.0): opening a TIFF ran server/images.ts firstTiffPage() -> UTIF.decode, which
// follows the IFD chain with no cycle detection. A 26-byte TIFF whose IFD points at itself made
// UTIF.decode allocate until the process aborted with "JavaScript heap out of memory", killing the
// forked plugin child, which the host never respawns. server/tiff.ts now walks the structure with
// bounds first. The decode runs in a heap-capped child so a regression cannot take down the worker.

const WIDTH = 256;
const HEIGHT = 257;
const SHORT = 3;
const LONG = 4;
const SUB_IFDS = 330;

describe("audit: TIFF IFD cycle", () => {
  it("refuses a self-referential TIFF without crashing the process", async () => {
    const result = await runCapped(
      `import { imageSize } from ${pluginModule("server/images.ts")};
       imageSize(Buffer.from(process.argv[2], "base64"), "decoded").then(() => console.log("opened"), (error) => console.log(error.message));`,
      [selfReferentialTiff().toString("base64")],
    );
    expect(result).toMatchObject({ code: 0, signal: null });
    expect(result.stdout).toMatch(/TIFF image is damaged: image directories form a loop/);
  }, 30_000);

  it("refuses an entry whose value count runs past the end of the file", async () => {
    const inflated = tiffWithEntries([[WIDTH, SHORT, 1, 1], [HEIGHT, SHORT, 1, 1], [258, SHORT, 0x7fffffff, 8]]);
    expect(() => assertTiffStructure(inflated)).toThrow(/points outside the file/);
    await expect(imageSize(inflated, "decoded")).rejects.toThrow(/TIFF image is damaged/);
  });

  it("refuses a sub-IFD that points back at its parent", async () => {
    const loop = tiffWithEntries([[WIDTH, SHORT, 1, 1], [HEIGHT, SHORT, 1, 1], [SUB_IFDS, LONG, 1, 8]]);
    expect(() => assertTiffStructure(loop)).toThrow(/form a loop/);
  });

  it("still reads an ordinary one-directory TIFF header", async () => {
    const plain = tiffWithEntries([[WIDTH, SHORT, 1, 3], [HEIGHT, SHORT, 1, 2]]);
    expect(() => assertTiffStructure(plain)).not.toThrow();
    expect(await imageSize(plain, "decoded")).toEqual({ width: 3, height: 2 });
  });
});
